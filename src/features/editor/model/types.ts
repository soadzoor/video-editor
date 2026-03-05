export interface SourceClip {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
}

export interface TimelineItem {
  id: string;
  sourceClipId: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  scale: number;
  panX: number;
  panY: number;
}

export interface TimelineDisplayItem extends TimelineItem {
  index: number;
  duration: number;
  timelineStart: number;
  timelineEnd: number;
}

export interface EditedSegment {
  id: string;
  timelineItemId: string;
  clipId: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  scale: number;
  panX: number;
  panY: number;
  timelineStart: number;
  timelineEnd: number;
  editedStart: number;
  editedEnd: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropDragMode =
  | "move"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface CropDragState {
  pointerId: number;
  mode: CropDragMode;
  startClientX: number;
  startClientY: number;
  overlayLeftPx: number;
  overlayTopPx: number;
  overlayWidthPx: number;
  overlayHeightPx: number;
  workspaceWidth: number;
  workspaceHeight: number;
  startRect: CropRect;
}

export interface PreviewPanDragState {
  timelineItemId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  overlayWidthPx: number;
  overlayHeightPx: number;
  workspaceWidth: number;
  workspaceHeight: number;
  initialScale: number;
  initialPanX: number;
  initialPanY: number;
  baseX: number;
  baseY: number;
  drawWidth: number;
  drawHeight: number;
  cropRect: CropRect;
}

export interface TrimWindowDragState {
  pointerId: number;
  startClientX: number;
  railWidthPx: number;
  initialStartSec: number;
  initialEndSec: number;
  mode: "start" | "end";
}

export interface PlayheadDragState {
  pointerId: number;
  railLeftPx: number;
  railWidthPx: number;
}

export type TimelineTool = "select" | "razor";
export type DockTab = "timeline" | "export";
export type UtilityTab = "crop" | "inspector";
export type ActiveSplitter = "left" | "right" | null;

export interface WorkspacePaneSizes {
  left: number;
  right: number;
}

export interface PersistedLayoutV1 {
  left: number;
  right: number;
  dockTab: DockTab;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
}

export interface InspectorOpenState {
  segment: boolean;
  crop: boolean;
  transform: boolean;
  speed: boolean;
  advancedExport: boolean;
}

export interface SplitterDragState {
  splitter: Exclude<ActiveSplitter, null>;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSizes: WorkspacePaneSizes;
}
