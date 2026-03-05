import type { ExportFormat } from "../../../ffmpeg/export";
import type { DockTab, WorkspacePaneSizes } from "./types";

export const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: "mp4", label: "MP4 (H.264)" },
  { value: "mov", label: "MOV (QuickTime)" },
  { value: "avi", label: "AVI" },
  { value: "mkv", label: "MKV (H.264)" },
  { value: "gif", label: "Animated GIF" },
  { value: "mp3", label: "MP3 (Audio Only)" },
  { value: "wav", label: "WAV (Audio Only)" }
];

export const MIN_EDIT_GAP_SEC = 0.1;
export const SEGMENT_END_EPSILON = 0.03;
export const MIN_SEGMENT_SPEED = 0.001;
export const MAX_SEGMENT_SPEED = 1000;
export const MIN_SEGMENT_SPEED_LOG = Math.log10(MIN_SEGMENT_SPEED);
export const MAX_SEGMENT_SPEED_LOG = Math.log10(MAX_SEGMENT_SPEED);
export const TRIM_SNAP_STEP_SEC = 0.001;
export const TIMELINE_SNAP_THRESHOLD_PX = 12;
export const MIN_CROP_SIZE_PX = 2;
export const PAN_SNAP_THRESHOLD_PX = 12;
export const MIN_PIECE_SCALE = 0.001;
export const MAX_PIECE_SCALE = 1000;
export const MIN_PIECE_SCALE_LOG = Math.log10(MIN_PIECE_SCALE);
export const MAX_PIECE_SCALE_LOG = Math.log10(MAX_PIECE_SCALE);
export const PREVIEW_UI_POSITION_STEP_SEC = 1 / 30;
export const DESKTOP_BREAKPOINT_PX = 1200;
export const LAYOUT_STORAGE_KEY = "videoEditor.layout.v1";
export const DEFAULT_DOCK_TAB: DockTab = "timeline";
export const DEFAULT_PANE_SIZES: WorkspacePaneSizes = {
  left: 280,
  right: 360
};
export const PANE_BOUNDS = {
  left: { min: 220, max: 420 },
  right: { min: 300, max: 520 }
} as const;
export const COLLAPSED_PANEL_WIDTH_PX = 42;
