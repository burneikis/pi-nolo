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
  "printenv",
  "git status",
  "git log",
  "git diff",
  "git show",

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

// Shell constructs that are dangerous regardless of position.
// Checked against the raw sub-command string.
const DANGEROUS_SHELL_CONSTRUCTS: RegExp[] = [
  /`/,
  /\$\(/,
  />\s/,
  />>/,
];

// Commands that are dangerous when they appear as the first token
// of a sub-command. Checked only against the first token, so paths
// like /opt/rm-old/ or quoted strings like grep "rm" won't match.
const DANGEROUS_COMMANDS: string[] = [
  "rm",
  "sudo",
  "eval",
  "exec",
  "source",
  "sh",
  "bash",
];

// Command-specific dangerous flags, checked only when the
// sub-command matches the corresponding safe prefix.
// Patterns run against the quote-stripped string to avoid
// false positives from flag names inside quoted arguments.
const COMMAND_DANGEROUS_FLAGS: Record<string, RegExp[]> = {
  find: [/\s-exec\b/, /\s-execdir\b/, /\s-delete\b/],
  fd: [/\s-x\b/, /\s-X\b/, /\s--exec\b/, /\s--exec-batch\b/],
};

// --- Quote-aware command splitting ---

/**
 * Split a shell command on unquoted |, ||, &&, ;
 * Respects single quotes, double quotes, and backslash escapes.
 */
function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "\\" && i + 1 < command.length) {
      current += command[i] + command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end + 1;
      current += command.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        j++;
      }
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if ((ch === "|" && command[i + 1] === "|") || (ch === "&" && command[i + 1] === "&")) {
      parts.push(current);
      current = "";
      i += 2;
      continue;
    }

    if (ch === "|" || ch === ";") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Strip content inside single and double quotes from a command string.
 * Used before running command-specific flag checks so that patterns
 * don't match inside quoted arguments (e.g. find . -name "-exec").
 */
function stripQuotedStrings(command: string): string {
  let result = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "\\" && i + 1 < command.length) {
      result += command[i] + command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        j++;
      }
      i = j + 1;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// --- Config types ---

interface NoloConfig {
  safePrefixes: string[];
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

function loadConfig(): { safePrefixes: string[] } {
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

  return { safePrefixes };
}

// --- Safety check ---

function isSafeCommand(
  command: string,
  safePrefixes: string[],
): boolean {
  const trimmed = command.trim();

  // Split on unquoted pipes/chains and check each sub-command.
  // Safe only if every sub-command passes all checks.
  const parts = splitShellCommand(trimmed);

  return parts.every((part) => {
    const sub = part.trim();

    // 1. Check shell constructs on the raw string
    for (const re of DANGEROUS_SHELL_CONSTRUCTS) {
      if (re.test(sub)) return false;
    }

    // 2. Check if the first token is a dangerous command
    const firstToken = sub.split(/\s/)[0];
    if (DANGEROUS_COMMANDS.includes(firstToken)) return false;

    // 3. Match against safe prefixes
    for (const prefix of safePrefixes) {
      if (
        sub === prefix ||
        sub.startsWith(prefix + " ") ||
        sub.startsWith(prefix + "\n")
      ) {
        // 4. Check command-specific dangerous flags (on unquoted string)
        const cmdPatterns = COMMAND_DANGEROUS_FLAGS[prefix];
        if (cmdPatterns) {
          const unquoted = stripQuotedStrings(sub);
          for (const re of cmdPatterns) {
            if (re.test(unquoted)) return false;
          }
        }
        return true;
      }
    }
    return false;
  });
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  let safePrefixes: string[] = DEFAULT_SAFE_PREFIXES;
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
        ctx.ui.notify(
          `YOLO mode off — all mutations require confirmation`,
          "info",
        );
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
      if (isSafeCommand(command, safePrefixes)) {
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
