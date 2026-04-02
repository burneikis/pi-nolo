/**
 * Confirm All Writes Extension (pi-nolo)
 *
 * Gates write, edit, and bash tools behind user confirmation (Enter to allow, Escape to block).
 * Read-safe bash commands (ls, grep, git status, etc.) are auto-approved via a configurable allowlist.
 * Commands containing dangerous patterns (pipes, chaining, redirects, etc.) always require confirmation.
 *
 * YOLO modes (toggle with /yolo or ctrl+y):
 *   off        — default: confirm all writes/edits/bash (safe bash commands auto-approved)
 *   writes     — auto-allow all write/edit; bash still follows safe-prefix rules
 *   full       — auto-allow everything: write, edit, and all bash commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, DEFAULT_SAFE_PREFIXES, DEFAULT_DANGEROUS_PATTERNS } from "./src/config.js";
import { registerEditTool } from "./src/diff.js";
import { YoloState, YOLO_MODES, YOLO_ENTRY_TYPE, updateStatus, registerYoloControls } from "./src/yolo.js";
import { registerGate } from "./src/gate.js";

export default function (pi: ExtensionAPI) {
  // --- Eager diff preview for edit tool ---
  registerEditTool(pi);

  // --- Runtime state ---
  let safePrefixes: string[] = DEFAULT_SAFE_PREFIXES;
  let dangerousRegexes: RegExp[] = DEFAULT_DANGEROUS_PATTERNS.map((p) => new RegExp(p));
  const yolo = new YoloState();

  // --- Session start: restore mode + load config ---
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    safePrefixes = config.safePrefixes;
    dangerousRegexes = config.dangerousRegexes;

    // Restore YOLO mode from the last persisted session entry (if any)
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === YOLO_ENTRY_TYPE) {
        const saved = (entry.data as { mode?: string })?.mode;
        if (saved && YOLO_MODES.includes(saved as any)) {
          yolo.set(saved as any);
        }
        break;
      }
    }

    if (ctx.hasUI) updateStatus(yolo.get(), ctx);
  });

  // --- /yolo command and ctrl+y shortcut ---
  registerYoloControls(pi, yolo);

  // --- Tool confirmation gate ---
  registerGate(pi, yolo, () => safePrefixes, () => dangerousRegexes);
}
