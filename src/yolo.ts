import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Types ---

export type YoloMode = "off" | "writes" | "full";

export const YOLO_MODES: YoloMode[] = ["off", "writes", "full"];

export const YOLO_LABELS: Record<YoloMode, string> = {
  off: "nolo",
  writes: "writes",
  full: "yolo",
};

// Session entry type for persisting YOLO mode across reloads
export const YOLO_ENTRY_TYPE = "nolo:yolo-mode";

// --- State ---

export class YoloState {
  private mode: YoloMode = "off";

  get(): YoloMode {
    return this.mode;
  }

  set(mode: YoloMode) {
    this.mode = mode;
  }

  cycle(): YoloMode {
    const idx = YOLO_MODES.indexOf(this.mode);
    this.mode = YOLO_MODES[(idx + 1) % YOLO_MODES.length];
    return this.mode;
  }
}

// --- UI helpers ---

export function renderStatusText(mode: YoloMode, theme: any): string {
  if (mode === "off") return theme.fg("dim", YOLO_LABELS.off);
  if (mode === "writes") return theme.fg("warning", YOLO_LABELS.writes);
  return theme.fg("error", YOLO_LABELS.full);
}

export function updateStatus(
  mode: YoloMode,
  ctx: { ui: { setStatus: (id: string, text: string) => void; theme: any } },
) {
  ctx.ui.setStatus("nolo", renderStatusText(mode, ctx.ui.theme));
}

export function notifyCycle(mode: YoloMode, ctx: { ui: { notify: (msg: string, level: string) => void } }) {
  const label = YOLO_LABELS[mode];
  const messages: Record<YoloMode, string> = {
    off: `${label} — all mutations require confirmation`,
    writes: `${label} — write/edit auto-approved; bash still guarded`,
    full: `${label} — ALL tool calls auto-approved, no confirmations`,
  };
  ctx.ui.notify(messages[mode], "info");
}

// --- Registration ---

export function registerYoloControls(pi: ExtensionAPI, state: YoloState) {
  function cycleYolo(ctx: { hasUI: boolean; ui: any }) {
    const newMode = state.cycle();
    pi.appendEntry(YOLO_ENTRY_TYPE, { mode: newMode });
    if (ctx.hasUI) {
      updateStatus(newMode, ctx);
      notifyCycle(newMode, ctx);
    }
  }

  pi.registerCommand("yolo", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: async (_args, ctx) => cycleYolo(ctx),
  });

  pi.registerShortcut("ctrl+y", {
    description: "Cycle YOLO mode: off → writes-yolo → full-yolo → off",
    handler: async (ctx) => cycleYolo(ctx),
  });
}
