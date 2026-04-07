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
import { isSafeCommand } from "./src/safety.js";
import {
  createYoloState,
  restoreYoloMode,
  renderStatus,
  cycleYoloMode,
} from "./src/yolo.js";

export default function (pi: ExtensionAPI) {
  let safePrefixes = DEFAULT_SAFE_PREFIXES;
  let dangerousRegexes = DEFAULT_DANGEROUS_PATTERNS.map((p) => new RegExp(p));
  const yolo = createYoloState();

  // --- Session start: restore mode + reload config ---

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    safePrefixes = config.safePrefixes;
    dangerousRegexes = config.dangerousRegexes;

    restoreYoloMode(ctx.sessionManager.getEntries(), yolo);

    if (ctx.hasUI) {
      ctx.ui.setStatus("nolo", renderStatus(yolo, ctx.ui.theme));
    }
  });

  // --- /yolo command and ctrl+y shortcut: cycle through modes ---

  const cycleHandler = async (_argsOrEvent: unknown, ctx: any) => {
    cycleYoloMode(yolo, pi, ctx);
  };

  pi.registerCommand("yolo", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: cycleHandler,
  });

  pi.registerShortcut("ctrl+y", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: async (ctx) => cycleYoloMode(yolo, pi, ctx),
  });

  // --- Tool gate ---

  pi.on("tool_call", async (event, ctx) => {
    const { toolName } = event;

    if (toolName === "write") {
      if (yolo.mode === "writes" || yolo.mode === "full") return undefined;
      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      const path = event.input.path as string;
      const content = (event.input.content as string) ?? "";
      const lines = content.split("\n").length;

      const confirmed = await ctx.ui.confirm("Write file?", `${path} (${lines} lines)`);
      if (!confirmed) return { block: true, reason: "Blocked by user" };

    } else if (toolName === "edit") {
      if (yolo.mode === "writes" || yolo.mode === "full") return undefined;
      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      const confirmed = await ctx.ui.confirm("Edit file?", event.input.path as string);
      if (!confirmed) return { block: true, reason: "Blocked by user" };

    } else if (toolName === "bash") {
      if (yolo.mode === "full") return undefined;
      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      const command = event.input.command as string;
      if (isSafeCommand(command, safePrefixes, dangerousRegexes)) return undefined;

      const confirmed = await ctx.ui.confirm("Run command?", command);
      if (!confirmed) return { block: true, reason: "Blocked by user" };
    }

    return undefined;
  });
}
