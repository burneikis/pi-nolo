import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditToolDefinition, renderDiff } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { readFileSync } from "fs";

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

const CONTEXT_LINES = 2;

/**
 * Build a diff string by eagerly applying edits to the current file content.
 * This allows the diff preview to be shown *before* the edit tool runs,
 * which is required for confirmation dialogs that fire during tool_call.
 */
export function buildEagerDiff(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  const fileContent = tryReadFile(path);
  const fileLines = fileContent?.split("\n") ?? [];
  const totalLines = fileLines.length;
  const gutterWidth = String(totalLines).length;

  const pad = (n: number) => String(n).padStart(gutterWidth, " ");
  const ctx  = (n: number) => ` ${pad(n)} ${fileLines[n - 1] ?? ""}`;
  const del  = (n: number, line: string) => `-${pad(n)} ${line}`;
  const add  = (n: number, line: string) => `+${pad(n)} ${line}`;

  const out: string[] = [];
  let lastEmittedLine = 0;

  for (const { oldText, newText } of edits) {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Determine start line. If oldText isn't found (e.g. resumed session where
    // edits were already applied), fall back to locating newText in the file.
    let startLine: number;
    let alreadyApplied = false;
    if (fileContent != null) {
      const oldIdx = fileContent.indexOf(oldText);
      if (oldIdx !== -1) {
        startLine = fileContent.slice(0, oldIdx).split("\n").length;
      } else {
        const newIdx = fileContent.indexOf(newText);
        if (newIdx !== -1) {
          startLine = fileContent.slice(0, newIdx).split("\n").length;
          alreadyApplied = true;
        } else {
          startLine = 1;
        }
      }
    } else {
      startLine = 1;
    }

    const endLine = startLine + (alreadyApplied ? newLines.length : oldLines.length) - 1;

    // Gap separator between non-contiguous edits
    const ctxStart = Math.max(lastEmittedLine + 1, startLine - CONTEXT_LINES);
    if (lastEmittedLine > 0 && ctxStart > lastEmittedLine + 1) {
      out.push(` ${" ".repeat(gutterWidth)} ...`);
    }

    // Context before
    for (let k = ctxStart; k < startLine; k++) out.push(ctx(k));
    // Removed / added
    for (let j = 0; j < oldLines.length; j++) out.push(del(startLine + j, oldLines[j]));
    for (let j = 0; j < newLines.length; j++) out.push(add(startLine + j, newLines[j]));
    // Context after
    const ctxEnd = Math.min(totalLines, endLine + CONTEXT_LINES);
    for (let k = endLine + 1; k <= ctxEnd; k++) out.push(ctx(k));

    lastEmittedLine = ctxEnd;
  }

  return out.join("\n");
}

/** Sentinel properties we attach to a Text component to cache the eager diff. */
const CACHED_DIFF = Symbol("cachedEagerDiff");
const CACHED_EDIT_COUNT = Symbol("cachedEditCount");

interface TextWithCache extends Text {
  [CACHED_DIFF]?: string;
  [CACHED_EDIT_COUNT]?: number;
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
        const text = (context.lastComponent as TextWithCache | undefined) ?? new Text("", 0, 0);

        // Recompute diff when edit count changes (args stream incrementally),
        // but reuse the cache on re-renders after the tool has run (file is modified).
        const cached = text as TextWithCache;
        let diffStr = cached[CACHED_DIFF];
        if (diffStr === undefined || cached[CACHED_EDIT_COUNT] !== edits.length) {
          diffStr = buildEagerDiff(path, edits);
          cached[CACHED_DIFF] = diffStr;
          cached[CACHED_EDIT_COUNT] = edits.length;
        }

        if (diffStr) output += "\n\n" + renderDiff(diffStr);

        text.setText(output);
        return text;
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
