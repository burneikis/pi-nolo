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

// --- Config shape ---

export interface NoloConfig {
  safePrefixes: string[];
  dangerousPatterns: string[];
}
