import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isSafeCommand } from "./safety.js";
import { type YoloState } from "./yolo.js";

/**
 * Registers the tool_call event handler that gates write, edit, and bash
 * tool calls behind user confirmation based on the current YOLO mode.
 */
export function registerGate(
  pi: ExtensionAPI,
  state: YoloState,
  getSafePrefixes: () => string[],
  getDangerousRegexes: () => RegExp[],
) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    if (toolName === "write") {
      if (state.get() === "writes" || state.get() === "full") return undefined;

      const path = event.input.path as string;
      const content = event.input.content as string;
      const lines = content ? content.split("\n").length : 0;

      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      const confirmed = await ctx.ui.confirm("Write file?", `${path} (${lines} lines)`);
      if (!confirmed) return { block: true, reason: "Blocked by user" };

    } else if (toolName === "edit") {
      if (state.get() === "writes" || state.get() === "full") return undefined;

      const path = event.input.path as string;

      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      const confirmed = await ctx.ui.confirm("Edit file?", path);
      if (!confirmed) return { block: true, reason: "Blocked by user" };

    } else if (toolName === "bash") {
      if (state.get() === "full") return undefined;

      const command = event.input.command as string;

      if (!ctx.hasUI) return { block: true, reason: "Blocked by user" };

      if (isSafeCommand(command, getSafePrefixes(), getDangerousRegexes())) {
        return undefined;
      }

      const confirmed = await ctx.ui.confirm("Run command?", command);
      if (!confirmed) return { block: true, reason: "Blocked by user" };
    }

    return undefined;
  });
}
