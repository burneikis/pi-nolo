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

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
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
