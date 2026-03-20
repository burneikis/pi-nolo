/**
 * Confirm All Writes Extension (pi-nolo)
 *
 * Gates write, edit, and bash tools behind user confirmation (Enter to allow, Escape to block).
 * Useful for replacing auto-execute ("YOLO mode") with explicit approval for all mutations.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;

		if (toolName === "write") {
			const path = event.input.path as string;
			const content = event.input.content as string;
			const lines = content ? content.split("\n").length : 0;

			if (!ctx.hasUI) {
				return { block: true, reason: "Blocked by user" };
			}

			const confirmed = await ctx.ui.confirm("Write file?", `${path} (${lines} lines)`);
			if (!confirmed) {
				return { block: true, reason: "Blocked by user" };
			}
		} else if (toolName === "edit") {
			const path = event.input.path as string;

			if (!ctx.hasUI) {
				return { block: true, reason: "Blocked by user" };
			}

			const confirmed = await ctx.ui.confirm("Edit file?", path);
			if (!confirmed) {
				return { block: true, reason: "Blocked by user" };
			}
		} else if (toolName === "bash") {
			const command = event.input.command as string;

			if (!ctx.hasUI) {
				return { block: true, reason: "Blocked by user" };
			}

			const confirmed = await ctx.ui.confirm("Run command?", command);
			if (!confirmed) {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
