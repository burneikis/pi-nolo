// --- YOLO mode ---

export type YoloMode = "off" | "writes" | "full";

export const YOLO_MODES: YoloMode[] = ["off", "writes", "full"];

export const YOLO_LABELS: Record<YoloMode, string> = {
  off: "nolo",
  writes: "writes",
  full: "yolo",
};

/** Custom session entry type for persisting YOLO mode across reloads */
export const YOLO_ENTRY_TYPE = "nolo:yolo-mode";

/** Custom session entry type for persisting the scope-writes toggle across reloads */
export const SCOPE_WRITES_ENTRY_TYPE = "nolo:scope-writes";

// --- Config shape ---

export interface NoloConfig {
  safePrefixes: string[];
  dangerousPatterns: string[];
  segmentDangerousPatterns: string[];
  shortcut?: string;
  /**
   * When true, `writes` mode confirms write/edit calls that resolve outside the
   * project root. Can be toggled live with /scopewrites. Default: false.
   */
  defaultScopeWrites?: boolean;
}
