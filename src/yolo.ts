import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { YOLO_MODES, YOLO_LABELS, YOLO_ENTRY_TYPE, SCOPE_WRITES_ENTRY_TYPE } from "./types.js";
import type { YoloMode } from "./types.js";

export type { YoloMode };

/** Mutable YOLO state shared across the extension lifecycle. */
export interface YoloState {
  mode: YoloMode;
  /** When true, `writes` mode confirms write/edit calls outside the project root. */
  scopeWrites: boolean;
}

export function createYoloState(scopeWrites = false): YoloState {
  return { mode: "off", scopeWrites };
}

/**
 * Restore the persisted scope-writes toggle from session history. Falls back to
 * the provided default when no entry is found (call on session_start).
 */
export function restoreScopeWrites(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  state: YoloState,
): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === SCOPE_WRITES_ENTRY_TYPE) {
      const saved = (entry.data as { scopeWrites?: boolean })?.scopeWrites;
      if (typeof saved === "boolean") state.scopeWrites = saved;
      break;
    }
  }
}

/** Toggle scope-writes, persist to session, and notify the user. */
export function toggleScopeWrites(
  state: YoloState,
  pi: ExtensionAPI,
  ctx: { hasUI: boolean; ui: { notify: (msg: string, type: string) => void } },
): void {
  state.scopeWrites = !state.scopeWrites;
  pi.appendEntry(SCOPE_WRITES_ENTRY_TYPE, { scopeWrites: state.scopeWrites });

  if (!ctx.hasUI) return;
  if (state.scopeWrites) {
    ctx.ui.notify("scope-writes ON — writes mode confirms edits outside the project root", "info");
  } else {
    ctx.ui.notify("scope-writes OFF — writes mode auto-approves edits anywhere", "info");
  }
}

/** Restore persisted mode from the session history (call on session_start). */
export function restoreYoloMode(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  state: YoloState,
): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === YOLO_ENTRY_TYPE) {
      const saved = (entry.data as { mode?: YoloMode })?.mode;
      if (saved && YOLO_MODES.includes(saved)) {
        state.mode = saved;
      }
      break;
    }
  }
}

/** Render the status bar label for the current mode. */
export function renderStatus(
  state: YoloState,
  theme: { fg: (color: string, text: string) => string },
): string {
  if (state.mode === "off") return theme.fg("dim", YOLO_LABELS.off);
  if (state.mode === "writes") return theme.fg("warning", YOLO_LABELS.writes);
  return theme.fg("error", YOLO_LABELS.full);
}

/** Cycle mode, persist to session, and notify the user. */
export function cycleYoloMode(
  state: YoloState,
  pi: ExtensionAPI,
  ctx: { hasUI: boolean; ui: { setStatus: (id: string, text: string) => void; theme: any; notify: (msg: string, type: string) => void } },
): void {
  const currentIndex = YOLO_MODES.indexOf(state.mode);
  state.mode = YOLO_MODES[(currentIndex + 1) % YOLO_MODES.length];

  // Persist so mode survives /reload
  pi.appendEntry(YOLO_ENTRY_TYPE, { mode: state.mode });

  if (!ctx.hasUI) return;

  ctx.ui.setStatus("nolo", renderStatus(state, ctx.ui.theme));

  const label = YOLO_LABELS[state.mode];
  if (state.mode === "off") {
    ctx.ui.notify(`${label} — all mutations require confirmation`, "info");
  } else if (state.mode === "writes") {
    ctx.ui.notify(`${label} — write/edit auto-approved; bash still guarded`, "info");
  } else {
    ctx.ui.notify(`${label} — ALL tool calls auto-approved, no confirmations`, "info");
  }
}
