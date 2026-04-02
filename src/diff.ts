import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditToolDefinition, renderDiff } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { readFileSync } from "fs";

/**
 * Build a diff string by eagerly applying edits to the current file content.
 * This allows the diff preview to be shown *before* the edit tool runs,
 * which is required for confirmation dialogs that fire during tool_call.
 */
export function buildEagerDiff(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): string | null {
  let fileContent: string | null = null;
  try {
    fileContent = readFileSync(path, "utf-8");
  } catch {
    // File doesn't exist yet (new file) — no line numbers available.
  }

  const CONTEXT = 2;
  const fileLines = fileContent !== null ? fileContent.split("\n") : [];
  const totalLines = fileLines.length;

  const pad = (n: number) => String(n).padStart(String(totalLines).length, " ");

  const lines: string[] = [];
  let lastEmittedLine = 0;

  for (const { oldText, newText } of edits) {
    let oldStartLine = 1;
    if (fileContent !== null) {
      const idx = fileContent.indexOf(oldText);
      if (idx !== -1) {
        oldStartLine = fileContent.slice(0, idx).split("\n").length;
      }
    }

    const oldEditLines = oldText.split("\n");
    const newEditLines = newText.split("\n");

    // Context before
    const ctxStart = Math.max(lastEmittedLine + 1, oldStartLine - CONTEXT);
    if (lastEmittedLine > 0 && ctxStart > lastEmittedLine + 1) {
      lines.push(` ${" ".repeat(String(totalLines).length)} ...`);
    }
    for (let k = ctxStart; k < oldStartLine; k++) {
      lines.push(` ${pad(k)} ${fileLines[k - 1] ?? ""}`);
    }

    // Removed lines
    oldEditLines.forEach((line, j) => {
      lines.push(`-${pad(oldStartLine + j)} ${line}`);
    });
    // Added lines
    newEditLines.forEach((line, j) => {
      lines.push(`+${pad(oldStartLine + j)} ${line}`);
    });

    // Context after
    const oldEndLine = oldStartLine + oldEditLines.length - 1;
    const ctxEnd = Math.min(totalLines, oldEndLine + CONTEXT);
    for (let k = oldEndLine + 1; k <= ctxEnd; k++) {
      lines.push(` ${pad(k)} ${fileLines[k - 1] ?? ""}`);
    }

    lastEmittedLine = ctxEnd;
  }

  return lines.join("\n");
}

/**
 * Registers the built-in edit tool with an overridden renderCall that shows
 * a diff preview eagerly (before the tool runs), rather than after.
 */
export function registerEditTool(pi: ExtensionAPI) {
  const builtinEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...builtinEdit,

    renderCall(args, theme, context) {
      const path: string = (args as any)?.path ?? "";
      const edits: Array<{ oldText: string; newText: string }> =
        (args as any)?.edits ?? [];

      const shortPath = path.length > 60 ? "…" + path.slice(-59) : path;
      let header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortPath)}`;
      if (edits.length > 0) {
        header += theme.fg("dim", ` (${edits.length} edit${edits.length === 1 ? "" : "s"})`);
      }

      let output = header;

      if (edits.length > 0) {
        const diffStr = buildEagerDiff(path, edits);
        if (diffStr) {
          output += "\n\n" + renderDiff(diffStr);
        }
      }

      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(output);
      return text;
    },

    renderResult(result, _options, theme, context) {
      // Diff was already shown in renderCall — only surface errors here.
      if (context.isError) {
        const errorText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
        if (errorText) {
          const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          text.setText(`\n${theme.fg("error", errorText)}`);
          return text;
        }
      }
      const container = (context.lastComponent as Container | undefined) ?? new Container();
      container.clear();
      return container;
    },
  });
}
