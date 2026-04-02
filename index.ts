/**
 * Confirm All Writes Extension (pi-nolo)
 *
 * Gates write, edit, and bash tools behind user confirmation (Enter to allow, Escape to block).
 * Read-safe bash commands (ls, grep, git status, etc.) are auto-approved via a configurable allowlist.
 * Commands containing dangerous patterns (pipes, chaining, redirects, etc.) always require confirmation.
 *
 * YOLO modes (toggle with /yolo):
 *   off        — default: confirm all writes/edits/bash (safe bash commands auto-approved)
 *   writes     — auto-allow all write/edit; bash still follows safe-prefix rules
 *   full       — auto-allow everything: write, edit, and all bash commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditToolDefinition, renderDiff } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- YOLO mode type ---

type YoloMode = "off" | "writes" | "full";

const YOLO_MODES: YoloMode[] = ["off", "writes", "full"];

const YOLO_LABELS: Record<YoloMode, string> = {
  off: "nolo",
  writes: "writes",
  full: "yolo",
};

// Custom session entry type for persisting YOLO mode across reloads
const YOLO_ENTRY_TYPE = "nolo:yolo-mode";

// --- Default configuration ---

const DEFAULT_SAFE_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "fd",
  "tree",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whoami",
  "pwd",
  "echo",
  "date",
  "uname",
  "env",
  "printenv",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "npm list",
  "npm outdated",
  "npm view",
  "node --version",
  "python --version",
  "cargo --version",
  "rustc --version",
  "go version",
];

const DEFAULT_DANGEROUS_PATTERNS = [
  "\\|",
  "&&",
  "\\|\\|",
  ";",
  "`",
  "\\$\\(",
  ">\\s",
  ">>",
  "\\brm\\b",
  "\\bsudo\\b",
  "\\beval\\b",
  "\\bexec\\b",
  "\\bsource\\b",
  "\\bsh\\b",
  "\\bbash\\b",
];

// --- Config types ---

interface NoloConfig {
  safePrefixes: string[];
  dangerousPatterns: string[];
}

// --- Config loading ---

function loadJsonFile(path: string): Partial<NoloConfig> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadConfig(): { safePrefixes: string[]; dangerousRegexes: RegExp[] } {
  const globalPath = join(homedir(), ".pi", "agent", "nolo.json");
  const projectPath = join(".pi", "nolo.json");

  const globalCfg = loadJsonFile(globalPath);
  const projectCfg = loadJsonFile(projectPath);

  // Merge safe prefixes: union of defaults + global + project
  let safePrefixes = [...DEFAULT_SAFE_PREFIXES];
  if (globalCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...globalCfg.safePrefixes])];
  }
  if (projectCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...projectCfg.safePrefixes])];
  }

  // Dangerous patterns: project overrides global overrides defaults
  let dangerousPatterns = DEFAULT_DANGEROUS_PATTERNS;
  if (globalCfg?.dangerousPatterns) {
    dangerousPatterns = globalCfg.dangerousPatterns;
  }
  if (projectCfg?.dangerousPatterns) {
    dangerousPatterns = projectCfg.dangerousPatterns;
  }

  const dangerousRegexes = dangerousPatterns.map((p) => new RegExp(p));

  return { safePrefixes, dangerousRegexes };
}

// --- Safety check ---

function isSafeCommand(
  command: string,
  safePrefixes: string[],
  dangerousRegexes: RegExp[],
): boolean {
  const trimmed = command.trim();

  // Check dangerous patterns first — any match means unsafe
  for (const re of dangerousRegexes) {
    if (re.test(trimmed)) return false;
  }

  // Check if command matches a safe prefix
  for (const prefix of safePrefixes) {
    if (
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.startsWith(prefix + "\n")
    ) {
      return true;
    }
  }

  return false;
}

// --- Edit preview diff helpers ---

/**
 * Build a diff string (in the format renderDiff expects) by applying the edits
 * to the current file content — done synchronously so renderCall can use it.
 */
function buildEagerDiff(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): string | null {
  // Read the file so we can compute starting line numbers for each edit.
  let fileContent: string | null = null;
  try {
    fileContent = readFileSync(path, "utf-8");
  } catch {
    // File doesn't exist yet (new file) — no line numbers available.
  }

  const lines: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i];

    if (edits.length > 1) {
      lines.push(`@@ edit ${i + 1}/${edits.length} @@`);
    }

    // Compute 1-based starting line of this edit in the file.
    let oldStartLine = 1;
    let newStartLine = 1;
    if (fileContent !== null) {
      const idx = fileContent.indexOf(oldText);
      if (idx !== -1) {
        oldStartLine = fileContent.slice(0, idx).split("\n").length;
        newStartLine = oldStartLine;
      }
    }

    const oldLineCount = Math.max(
      String(oldStartLine + oldText.split("\n").length - 1).length,
      String(newStartLine + newText.split("\n").length - 1).length,
    );

    const pad = (n: number) => String(n).padStart(oldLineCount, " ");

    // Removed lines
    oldText.split("\n").forEach((line, j) => {
      lines.push(`-${pad(oldStartLine + j)} ${line}`);
    });
    // Added lines
    newText.split("\n").forEach((line, j) => {
      lines.push(`+${pad(newStartLine + j)} ${line}`);
    });
  }

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // --- Override edit tool renderCall to restore eager diff preview ---
  //
  // Since pi 0.63.2 the built-in edit tool deferred its diff to renderResult
  // (after the tool runs). pi-nolo's confirm dialog fires during tool_call,
  // before the tool runs, so the user saw the popup with no preview.
  // We override renderCall to compute and display the diff eagerly, so the
  // TUI shows the diff *before* the confirmation popup appears.
  const builtinEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...builtinEdit,
    renderCall(args, theme, context) {
      const path: string = (args as any)?.path ?? "";
      const edits: Array<{ oldText: string; newText: string }> =
        (args as any)?.edits ?? [];

      // Header line (same style as built-in: "edit <path>")
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
      // The diff was already shown eagerly in renderCall, so suppress the
      // post-run diff from renderResult. Only surface errors.
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
  let safePrefixes: string[] = DEFAULT_SAFE_PREFIXES;
  let dangerousRegexes: RegExp[] = DEFAULT_DANGEROUS_PATTERNS.map(
    (p) => new RegExp(p),
  );
  let yoloMode: YoloMode = "off";

  // --- Status helper ---

  function updateStatus(ctx: {
    ui: { setStatus: (id: string, text: string) => void; theme: any };
  }) {
    const theme = ctx.ui.theme;
    const mode = yoloMode;
    let text: string;
    if (mode === "off") {
      text = theme.fg("dim", YOLO_LABELS.off);
    } else if (mode === "writes") {
      text = theme.fg("warning", YOLO_LABELS.writes);
    } else {
      text = theme.fg("error", YOLO_LABELS.full);
    }
    ctx.ui.setStatus("nolo", text);
  }

  // --- Session start: restore mode + load config ---

  pi.on("session_start", async (_event, ctx) => {
    // Load config
    const config = loadConfig();
    safePrefixes = config.safePrefixes;
    dangerousRegexes = config.dangerousRegexes;

    // Restore YOLO mode from the last persisted entry (if any)
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === YOLO_ENTRY_TYPE) {
        const saved = (entry.data as { mode?: YoloMode })?.mode;
        if (saved && YOLO_MODES.includes(saved)) {
          yoloMode = saved;
        }
        break;
      }
    }

    if (ctx.hasUI) {
      updateStatus(ctx);
    }
  });

  // --- Shared cycle logic ---

  function cycleYolo(ctx: { hasUI: boolean; ui: any }) {
    const currentIndex = YOLO_MODES.indexOf(yoloMode);
    yoloMode = YOLO_MODES[(currentIndex + 1) % YOLO_MODES.length];

    // Persist mode to session so it survives /reload
    pi.appendEntry(YOLO_ENTRY_TYPE, { mode: yoloMode });

    if (ctx.hasUI) {
      updateStatus(ctx);
      const label = YOLO_LABELS[yoloMode];
      if (yoloMode === "off") {
        ctx.ui.notify(`${label} — all mutations require confirmation`, "info");
      } else if (yoloMode === "writes") {
        ctx.ui.notify(
          `${label} — write/edit auto-approved; bash still guarded`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `${label} — ALL tool calls auto-approved, no confirmations`,
          "info",
        );
      }
    }
  }

  // --- /yolo command: cycle through modes ---

  pi.registerCommand("yolo", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: async (_args, ctx) => {
      cycleYolo(ctx);
    },
  });

  // --- ctrl+y keybinding: cycle through modes ---

  pi.registerShortcut("ctrl+y", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: async (ctx) => {
      cycleYolo(ctx);
    },
  });

  // --- Tool gate ---

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    if (toolName === "write") {
      // writes-yolo and full-yolo both skip write confirmation
      if (yoloMode === "writes" || yoloMode === "full") {
        return undefined;
      }

      const path = event.input.path as string;
      const content = event.input.content as string;
      const lines = content ? content.split("\n").length : 0;

      if (!ctx.hasUI) {
        return { block: true, reason: "Blocked by user" };
      }

      const confirmed = await ctx.ui.confirm(
        "Write file?",
        `${path} (${lines} lines)`,
      );
      if (!confirmed) {
        return { block: true, reason: "Blocked by user" };
      }
    } else if (toolName === "edit") {
      // writes-yolo and full-yolo both skip edit confirmation
      if (yoloMode === "writes" || yoloMode === "full") {
        return undefined;
      }

      const path = event.input.path as string;

      if (!ctx.hasUI) {
        return { block: true, reason: "Blocked by user" };
      }

      const confirmed = await ctx.ui.confirm("Edit file?", path);
      if (!confirmed) {
        return { block: true, reason: "Blocked by user" };
      }
    } else if (toolName === "bash") {
      // full-yolo skips all bash confirmation, including dangerous commands
      if (yoloMode === "full") {
        return undefined;
      }

      const command = event.input.command as string;

      if (!ctx.hasUI) {
        return { block: true, reason: "Blocked by user" };
      }

      // Auto-approve safe read-only commands (in both "off" and "writes" modes)
      if (isSafeCommand(command, safePrefixes, dangerousRegexes)) {
        return undefined;
      }

      const confirmed = await ctx.ui.confirm("Run command?", command);
      if (!confirmed) {
        return { block: true, reason: "Blocked by user" };
      }
    }

    return undefined;
  });
}
