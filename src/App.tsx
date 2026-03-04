import {
  CSSProperties,
  ChangeEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  exportEditedTimeline,
  getExportFormatConfig,
  type ExportFormat,
  type ExportMode,
  type ExportStage
} from "./ffmpeg/export";
import {
  TimelinePreviewEngine,
  type PreviewClip,
  type PreviewSegment
} from "./preview-engine";

interface SourceClip {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
}

interface TimelineItem {
  id: string;
  sourceClipId: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  scale: number;
  panX: number;
  panY: number;
}

interface TimelineDisplayItem extends TimelineItem {
  index: number;
  duration: number;
  timelineStart: number;
  timelineEnd: number;
}

interface EditedSegment {
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

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CropDragMode =
  | "move"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

interface CropDragState {
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

interface PreviewPanDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  overlayWidthPx: number;
  overlayHeightPx: number;
  workspaceWidth: number;
  workspaceHeight: number;
  initialPanX: number;
  initialPanY: number;
  baseX: number;
  baseY: number;
  drawWidth: number;
  drawHeight: number;
  cropRect: CropRect;
}

interface TrimWindowDragState {
  pointerId: number;
  startClientX: number;
  railWidthPx: number;
  initialStartSec: number;
  initialEndSec: number;
  mode: "start" | "end";
}

interface PlayheadDragState {
  pointerId: number;
  railLeftPx: number;
  railWidthPx: number;
}

type TimelineTool = "select" | "razor";
type DockTab = "timeline" | "export";
type UtilityTab = "crop" | "inspector";
type ActiveSplitter = "left" | "right" | null;

interface WorkspacePaneSizes {
  left: number;
  right: number;
}

interface PersistedLayoutV1 {
  left: number;
  right: number;
  dockTab: DockTab;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
}

interface InspectorOpenState {
  segment: boolean;
  crop: boolean;
  transform: boolean;
  speed: boolean;
  advancedExport: boolean;
}

interface SplitterDragState {
  splitter: Exclude<ActiveSplitter, null>;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSizes: WorkspacePaneSizes;
}

const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: "mp4", label: "MP4 (H.264)" },
  { value: "mov", label: "MOV (QuickTime)" },
  { value: "avi", label: "AVI" },
  { value: "mkv", label: "MKV (H.264)" },
  { value: "gif", label: "Animated GIF" },
  { value: "mp3", label: "MP3 (Audio Only)" },
  { value: "wav", label: "WAV (Audio Only)" }
];

const MIN_EDIT_GAP_SEC = 0.1;
const SEGMENT_END_EPSILON = 0.03;
const MIN_SEGMENT_SPEED = 0.001;
const MAX_SEGMENT_SPEED = 1000;
const MIN_SEGMENT_SPEED_LOG = Math.log10(MIN_SEGMENT_SPEED);
const MAX_SEGMENT_SPEED_LOG = Math.log10(MAX_SEGMENT_SPEED);
const TRIM_SNAP_STEP_SEC = 0.001;
const TIMELINE_SNAP_THRESHOLD_PX = 12;
const MIN_CROP_SIZE_PX = 2;
const PAN_SNAP_THRESHOLD_PX = 12;
const MIN_PIECE_SCALE = 0.001;
const MAX_PIECE_SCALE = 1000;
const MIN_PIECE_SCALE_LOG = Math.log10(MIN_PIECE_SCALE);
const MAX_PIECE_SCALE_LOG = Math.log10(MAX_PIECE_SCALE);
const PREVIEW_UI_POSITION_STEP_SEC = 1 / 30;
const DESKTOP_BREAKPOINT_PX = 1200;
const LAYOUT_STORAGE_KEY = "videoEditor.layout.v1";
const DEFAULT_DOCK_TAB: DockTab = "timeline";
const DEFAULT_PANE_SIZES: WorkspacePaneSizes = {
  left: 280,
  right: 360
};
const PANE_BOUNDS = {
  left: { min: 220, max: 420 },
  right: { min: 300, max: 520 }
} as const;
const COLLAPSED_PANEL_WIDTH_PX = 42;

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.000001;
}

function clampPaneSizes(sizes: WorkspacePaneSizes): WorkspacePaneSizes {
  return {
    left: Math.round(clamp(sizes.left, PANE_BOUNDS.left.min, PANE_BOUNDS.left.max)),
    right: Math.round(clamp(sizes.right, PANE_BOUNDS.right.min, PANE_BOUNDS.right.max))
  };
}

function readPersistedLayout(): PersistedLayoutV1 | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedLayoutV1>;
    const left = Number(parsed.left);
    const right = Number(parsed.right);
    const dockTab = parsed.dockTab;
    if (
      !parsed ||
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      (dockTab !== "timeline" && dockTab !== "export")
    ) {
      return null;
    }

    return {
      left,
      right,
      dockTab,
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true
    };
  } catch {
    return null;
  }
}

function isDesktopViewportWidth(width: number): boolean {
  return width >= DESKTOP_BREAKPOINT_PX;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatSecondsLabel(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(2)}s`;
}

function formatEta(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  const sizeMb = bytes / (1024 * 1024);
  return `${sizeMb.toFixed(2)} MB`;
}

function clampSpeed(value: number): number {
  return clamp(value, MIN_SEGMENT_SPEED, MAX_SEGMENT_SPEED);
}

function speedToLogSliderValue(speed: number): number {
  return clamp(Math.log10(clampSpeed(speed)), MIN_SEGMENT_SPEED_LOG, MAX_SEGMENT_SPEED_LOG);
}

function logSliderValueToSpeed(value: number): number {
  return clampSpeed(10 ** clamp(value, MIN_SEGMENT_SPEED_LOG, MAX_SEGMENT_SPEED_LOG));
}

function formatSpeedLabel(speed: number): string {
  return Number(clampSpeed(speed).toPrecision(6)).toString();
}

function clampPieceScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, MIN_PIECE_SCALE, MAX_PIECE_SCALE);
}

function scaleToLogSliderValue(scale: number): number {
  return clamp(Math.log10(clampPieceScale(scale)), MIN_PIECE_SCALE_LOG, MAX_PIECE_SCALE_LOG);
}

function logSliderValueToScale(value: number): number {
  return clampPieceScale(10 ** clamp(value, MIN_PIECE_SCALE_LOG, MAX_PIECE_SCALE_LOG));
}

function formatScaleLabel(scale: number): string {
  return Number(clampPieceScale(scale).toPrecision(6)).toString();
}

function normalizePanValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

function parsePositiveIntegerInput(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

function parseNonNegativeIntegerInput(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
}

function durationPartsFromSeconds(seconds: number): {
  minutes: number;
  seconds: number;
  milliseconds: number;
} {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const secondsPart = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return { minutes, seconds: secondsPart, milliseconds };
}

function normalizeTimeValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeCropRect(rect: CropRect, workspaceWidth: number, workspaceHeight: number): CropRect {
  const maxWidth = Math.max(MIN_CROP_SIZE_PX, Math.round(workspaceWidth));
  const maxHeight = Math.max(MIN_CROP_SIZE_PX, Math.round(workspaceHeight));
  const width = clamp(Math.round(rect.width), MIN_CROP_SIZE_PX, maxWidth);
  const height = clamp(Math.round(rect.height), MIN_CROP_SIZE_PX, maxHeight);
  const x = clamp(Math.round(rect.x), 0, Math.max(0, maxWidth - width));
  const y = clamp(Math.round(rect.y), 0, Math.max(0, maxHeight - height));
  return { x, y, width, height };
}

function snapAxisToNearestEdge(rawValue: number, edgeA: number, edgeB: number, thresholdPx: number): number {
  const distA = Math.abs(rawValue - edgeA);
  const distB = Math.abs(rawValue - edgeB);
  const nearest = distA <= distB ? edgeA : edgeB;
  return Math.abs(rawValue - nearest) <= thresholdPx ? nearest : rawValue;
}

function snapPanToCropEdges(
  rawPanX: number,
  rawPanY: number,
  baseX: number,
  baseY: number,
  drawWidth: number,
  drawHeight: number,
  cropRect: CropRect
): { panX: number; panY: number } {
  const cropLeft = cropRect.x;
  const cropRight = cropRect.x + cropRect.width;
  const cropTop = cropRect.y;
  const cropBottom = cropRect.y + cropRect.height;

  const targetPanXLeft = cropLeft - baseX;
  const targetPanXRight = cropRight - (baseX + drawWidth);
  const targetPanYTop = cropTop - baseY;
  const targetPanYBottom = cropBottom - (baseY + drawHeight);

  return {
    panX: snapAxisToNearestEdge(rawPanX, targetPanXLeft, targetPanXRight, PAN_SNAP_THRESHOLD_PX),
    panY: snapAxisToNearestEdge(rawPanY, targetPanYTop, targetPanYBottom, PAN_SNAP_THRESHOLD_PX)
  };
}

function exportStageLabel(stage: ExportStage): string {
  switch (stage) {
    case "loading-core":
      return "Loading FFmpeg core...";
    case "preparing-inputs":
      return "Preparing source files...";
    case "processing-fast":
      return "Building edited timeline...";
    case "processing-reencode":
      return "Re-encoding timeline segments...";
    case "finalizing":
      return "Finalizing export...";
  }
}

async function loadVideoMetadata(
  url: string
): Promise<{ duration: number; width: number; height: number }> {
  const video = document.createElement("video");
  video.preload = "metadata";

  return new Promise((resolve, reject) => {
    const handleLoaded = () => {
      const metadata = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0
      };
      cleanup();
      resolve(metadata);
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Unable to read video metadata."));
    };

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      video.src = "";
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    video.src = url;
  });
}

function timelineDurationFromItems(items: TimelineItem[]): number {
  return items.reduce((sum, item) => {
    const sourceDuration = Math.max(0, item.sourceEnd - item.sourceStart);
    const speed = clampSpeed(item.speed);
    return sum + sourceDuration / speed;
  }, 0);
}

function buildTimelineDisplayItems(items: TimelineItem[]): TimelineDisplayItem[] {
  const displayItems: TimelineDisplayItem[] = [];
  let offset = 0;

  for (const [index, item] of items.entries()) {
    const sourceDuration = Math.max(0, item.sourceEnd - item.sourceStart);
    const speed = clampSpeed(item.speed);
    const duration = sourceDuration / speed;
    if (duration <= 0.001) {
      continue;
    }

    displayItems.push({
      ...item,
      speed,
      index,
      duration,
      timelineStart: offset,
      timelineEnd: offset + duration
    });
    offset += duration;
  }

  return displayItems;
}

function buildEditedSegments(
  timelineItems: TimelineDisplayItem[],
  trimStartSec: number,
  trimEndSec: number
): EditedSegment[] {
  const totalDuration =
    timelineItems.length > 0 ? timelineItems[timelineItems.length - 1].timelineEnd : 0;
  if (totalDuration <= 0) {
    return [];
  }

  const keepStart = clamp(trimStartSec, 0, totalDuration);
  const keepEnd = clamp(trimEndSec, keepStart, totalDuration);
  if (keepEnd - keepStart <= 0.001) {
    return [];
  }

  let editedOffset = 0;
  const editedSegments: EditedSegment[] = [];

  for (const item of timelineItems) {
    const overlapStart = Math.max(item.timelineStart, keepStart);
    const overlapEnd = Math.min(item.timelineEnd, keepEnd);
    if (overlapEnd - overlapStart <= 0.001) {
      continue;
    }

    const sourceStart = item.sourceStart + (overlapStart - item.timelineStart) * item.speed;
    const sourceEnd = item.sourceStart + (overlapEnd - item.timelineStart) * item.speed;
    const duration = overlapEnd - overlapStart;

    editedSegments.push({
      id: `${item.id}:${sourceStart.toFixed(5)}:${sourceEnd.toFixed(5)}:${item.speed.toFixed(4)}`,
      timelineItemId: item.id,
      clipId: item.sourceClipId,
      sourceStart,
      sourceEnd,
      speed: item.speed,
      scale: item.scale,
      panX: item.panX,
      panY: item.panY,
      timelineStart: overlapStart,
      timelineEnd: overlapEnd,
      editedStart: editedOffset,
      editedEnd: editedOffset + duration
    });

    editedOffset += duration;
  }

  return editedSegments;
}

function findSegmentIndex(segments: EditedSegment[], timeSec: number): number {
  if (segments.length === 0) {
    return -1;
  }

  for (const [index, segment] of segments.entries()) {
    if (timeSec >= segment.editedStart && timeSec < segment.editedEnd) {
      return index;
    }
  }

  return segments.length - 1;
}

function snapTimelineValueToTargets(
  valueSec: number,
  targetsSec: number[],
  railWidthPx: number,
  timelineDurationSec: number
): number {
  if (!Number.isFinite(valueSec) || railWidthPx <= 0 || timelineDurationSec <= 0) {
    return valueSec;
  }

  const thresholdSec =
    (TIMELINE_SNAP_THRESHOLD_PX / Math.max(1, railWidthPx)) * timelineDurationSec;

  let nearest = valueSec;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const target of targetsSec) {
    if (!Number.isFinite(target)) {
      continue;
    }
    const distance = Math.abs(valueSec - target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = target;
    }
  }

  return nearestDistance <= thresholdSec ? nearest : valueSec;
}

function moveTimelineItem(
  items: TimelineItem[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean
): TimelineItem[] {
  if (draggedId === targetId) {
    return items;
  }

  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  let insertIndex = next.findIndex((item) => item.id === targetId);
  if (insertIndex < 0) {
    return items;
  }

  if (placeAfter) {
    insertIndex += 1;
  }

  next.splice(insertIndex, 0, dragged);
  return next;
}

function isKeyboardEventFromInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return (
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"
    ) !== null
  );
}

function convertClientToWorkspace(
  clientX: number,
  clientY: number,
  drag: CropDragState
): { x: number; y: number } {
  const ratioX =
    drag.overlayWidthPx <= 0 ? 0 : clamp((clientX - drag.overlayLeftPx) / drag.overlayWidthPx, 0, 1);
  const ratioY =
    drag.overlayHeightPx <= 0 ? 0 : clamp((clientY - drag.overlayTopPx) / drag.overlayHeightPx, 0, 1);
  return {
    x: ratioX * drag.workspaceWidth,
    y: ratioY * drag.workspaceHeight
  };
}

function applyCropDrag(
  drag: CropDragState,
  clientX: number,
  clientY: number,
  lockAspect: boolean,
  aspectRatio: number
): CropRect {
  const { x: pointerX, y: pointerY } = convertClientToWorkspace(clientX, clientY, drag);
  const { x, y, width, height } = drag.startRect;
  const startLeft = x;
  const startTop = y;
  const startRight = x + width;
  const startBottom = y + height;
  const dx = ((clientX - drag.startClientX) / Math.max(1, drag.overlayWidthPx)) * drag.workspaceWidth;
  const dy = ((clientY - drag.startClientY) / Math.max(1, drag.overlayHeightPx)) * drag.workspaceHeight;

  let left = startLeft;
  let right = startRight;
  let top = startTop;
  let bottom = startBottom;

  if (drag.mode === "move") {
    const nextLeft = clamp(startLeft + dx, 0, Math.max(0, drag.workspaceWidth - width));
    const nextTop = clamp(startTop + dy, 0, Math.max(0, drag.workspaceHeight - height));
    return normalizeCropRect(
      {
        x: nextLeft,
        y: nextTop,
        width,
        height
      },
      drag.workspaceWidth,
      drag.workspaceHeight
    );
  }

  if (drag.mode.includes("left")) {
    left = clamp(pointerX, 0, right - MIN_CROP_SIZE_PX);
  }
  if (drag.mode.includes("right")) {
    right = clamp(pointerX, left + MIN_CROP_SIZE_PX, drag.workspaceWidth);
  }
  if (drag.mode.includes("top")) {
    top = clamp(pointerY, 0, bottom - MIN_CROP_SIZE_PX);
  }
  if (drag.mode.includes("bottom")) {
    bottom = clamp(pointerY, top + MIN_CROP_SIZE_PX, drag.workspaceHeight);
  }

  if (!lockAspect || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return normalizeCropRect(
      { x: left, y: top, width: right - left, height: bottom - top },
      drag.workspaceWidth,
      drag.workspaceHeight
    );
  }

  const ratio = aspectRatio;
  const centerX = (startLeft + startRight) / 2;
  const centerY = (startTop + startBottom) / 2;

  if (drag.mode === "left" || drag.mode === "right") {
    const fixedX = drag.mode === "left" ? startRight : startLeft;
    let nextWidth = Math.abs(fixedX - (drag.mode === "left" ? left : right));
    const maxByBounds = drag.mode === "left" ? fixedX : drag.workspaceWidth - fixedX;
    nextWidth = clamp(nextWidth, MIN_CROP_SIZE_PX, Math.max(MIN_CROP_SIZE_PX, maxByBounds));
    let nextHeight = nextWidth / ratio;
    const maxHalfHeight = Math.min(centerY, drag.workspaceHeight - centerY);
    if (nextHeight / 2 > maxHalfHeight) {
      nextHeight = maxHalfHeight * 2;
      nextWidth = nextHeight * ratio;
    }
    left = drag.mode === "left" ? fixedX - nextWidth : fixedX;
    right = drag.mode === "left" ? fixedX : fixedX + nextWidth;
    top = centerY - nextHeight / 2;
    bottom = centerY + nextHeight / 2;
  } else if (drag.mode === "top" || drag.mode === "bottom") {
    const fixedY = drag.mode === "top" ? startBottom : startTop;
    let nextHeight = Math.abs(fixedY - (drag.mode === "top" ? top : bottom));
    const maxByBounds = drag.mode === "top" ? fixedY : drag.workspaceHeight - fixedY;
    nextHeight = clamp(nextHeight, MIN_CROP_SIZE_PX, Math.max(MIN_CROP_SIZE_PX, maxByBounds));
    let nextWidth = nextHeight * ratio;
    const maxHalfWidth = Math.min(centerX, drag.workspaceWidth - centerX);
    if (nextWidth / 2 > maxHalfWidth) {
      nextWidth = maxHalfWidth * 2;
      nextHeight = nextWidth / ratio;
    }
    top = drag.mode === "top" ? fixedY - nextHeight : fixedY;
    bottom = drag.mode === "top" ? fixedY : fixedY + nextHeight;
    left = centerX - nextWidth / 2;
    right = centerX + nextWidth / 2;
  } else {
    let anchorX = startLeft;
    let anchorY = startTop;
    let widthFromX = right - left;
    let heightFromY = bottom - top;

    if (drag.mode === "top-left") {
      anchorX = startRight;
      anchorY = startBottom;
      widthFromX = anchorX - left;
      heightFromY = anchorY - top;
    } else if (drag.mode === "top-right") {
      anchorX = startLeft;
      anchorY = startBottom;
      widthFromX = right - anchorX;
      heightFromY = anchorY - top;
    } else if (drag.mode === "bottom-left") {
      anchorX = startRight;
      anchorY = startTop;
      widthFromX = anchorX - left;
      heightFromY = bottom - anchorY;
    } else if (drag.mode === "bottom-right") {
      anchorX = startLeft;
      anchorY = startTop;
      widthFromX = right - anchorX;
      heightFromY = bottom - anchorY;
    }

    const widthViaHeight = heightFromY * ratio;
    let nextWidth = Math.min(widthFromX, widthViaHeight);
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
      nextWidth = widthFromX;
    }
    nextWidth = Math.max(MIN_CROP_SIZE_PX, nextWidth);
    let nextHeight = nextWidth / ratio;

    const maxWidth =
      drag.mode.includes("left") ? anchorX : drag.workspaceWidth - anchorX;
    const maxHeight =
      drag.mode.includes("top") ? anchorY : drag.workspaceHeight - anchorY;
    if (nextWidth > maxWidth) {
      nextWidth = maxWidth;
      nextHeight = nextWidth / ratio;
    }
    if (nextHeight > maxHeight) {
      nextHeight = maxHeight;
      nextWidth = nextHeight * ratio;
    }

    if (drag.mode === "top-left") {
      left = anchorX - nextWidth;
      right = anchorX;
      top = anchorY - nextHeight;
      bottom = anchorY;
    } else if (drag.mode === "top-right") {
      left = anchorX;
      right = anchorX + nextWidth;
      top = anchorY - nextHeight;
      bottom = anchorY;
    } else if (drag.mode === "bottom-left") {
      left = anchorX - nextWidth;
      right = anchorX;
      top = anchorY;
      bottom = anchorY + nextHeight;
    } else {
      left = anchorX;
      right = anchorX + nextWidth;
      top = anchorY;
      bottom = anchorY + nextHeight;
    }
  }

  return normalizeCropRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    drag.workspaceWidth,
    drag.workspaceHeight
  );
}

function App() {
  const [clips, setClips] = useState<SourceClip[]>([]);
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  const [isDragging, setIsDragging] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [trimStartSec, setTrimStartSec] = useState(0);
  const [trimEndSec, setTrimEndSec] = useState(0);
  const [previewPositionSec, setPreviewPositionSec] = useState(0);
  const [, setCurrentSegmentIndex] = useState(0);

  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
  const [selectedTimelineItemId, setSelectedTimelineItemId] = useState<string | null>(null);
  const [draggingTimelineItemId, setDraggingTimelineItemId] = useState<string | null>(null);

  const [isExporting, setIsExporting] = useState(false);
  const [exportStage, setExportStage] = useState<ExportStage | null>(null);
  const [exportStatusMessage, setExportStatusMessage] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportFrameProgress, setExportFrameProgress] = useState<{
    currentFrame: number;
    totalFrames: number;
    percent: number;
  } | null>(null);
  const [exportStartedAtMs, setExportStartedAtMs] = useState<number | null>(null);
  const [exportNowMs, setExportNowMs] = useState(() => Date.now());
  const [exportMode, setExportMode] = useState<ExportMode>("fast");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [exportWidthInput, setExportWidthInput] = useState("");
  const [exportHeightInput, setExportHeightInput] = useState("");
  const [exportFpsInput, setExportFpsInput] = useState("");
  const [includeVideoInExport, setIncludeVideoInExport] = useState(true);
  const [includeAudioInExport, setIncludeAudioInExport] = useState(true);
  const [exportVideoBitrateInput, setExportVideoBitrateInput] = useState("");
  const [exportAudioBitrateInput, setExportAudioBitrateInput] = useState("");
  const [dockTab, setDockTab] = useState<DockTab>(() => readPersistedLayout()?.dockTab ?? DEFAULT_DOCK_TAB);
  const [utilityTab, setUtilityTab] = useState<UtilityTab>("crop");
  const [workspacePaneSizes, setWorkspacePaneSizes] = useState<WorkspacePaneSizes>(() => {
    const persisted = readPersistedLayout();
    return clampPaneSizes(
      persisted
        ? {
            left: persisted.left,
            right: persisted.right
          }
        : DEFAULT_PANE_SIZES
    );
  });
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(
    () => readPersistedLayout()?.leftCollapsed === true
  );
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(
    () => readPersistedLayout()?.rightCollapsed === true
  );
  const [activeSplitter, setActiveSplitter] = useState<ActiveSplitter>(null);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() =>
    typeof window === "undefined" ? true : isDesktopViewportWidth(window.innerWidth)
  );
  const [inspectorOpenState, setInspectorOpenState] = useState<InspectorOpenState>({
    segment: true,
    crop: true,
    transform: true,
    speed: true,
    advancedExport: false
  });

  const [isDraggingTrimEdge, setIsDraggingTrimEdge] = useState(false);
  const [activeTrimEdge, setActiveTrimEdge] = useState<"start" | "end" | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [selectedSpeedInput, setSelectedSpeedInput] = useState("");
  const [selectedDurationMinutesInput, setSelectedDurationMinutesInput] = useState("");
  const [selectedDurationSecondsInput, setSelectedDurationSecondsInput] = useState("");
  const [selectedDurationMillisecondsInput, setSelectedDurationMillisecondsInput] = useState("");
  const [selectedScaleInput, setSelectedScaleInput] = useState("");
  const [selectedPanXInput, setSelectedPanXInput] = useState("");
  const [selectedPanYInput, setSelectedPanYInput] = useState("");
  const [cropEnabled, setCropEnabled] = useState(false);
  const [cropLockAspect, setCropLockAspect] = useState(true);
  const [cropAspectRatio, setCropAspectRatio] = useState(16 / 9);
  const [cropRect, setCropRect] = useState<CropRect>({
    x: 0,
    y: 0,
    width: 1280,
    height: 720
  });
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const [isDraggingPreviewPan, setIsDraggingPreviewPan] = useState(false);
  const [isPreviewSupported] = useState(
    () => typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewSurfaceRef = useRef<HTMLDivElement>(null);
  const previewEngineRef = useRef<TimelinePreviewEngine | null>(null);
  const previewSegmentsRef = useRef<EditedSegment[]>([]);
  const clipsRef = useRef<SourceClip[]>([]);
  const isPlayingRef = useRef(false);
  const togglePlayPauseRef = useRef<() => void>(() => undefined);
  const stepPreviewFrameRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  const cropDragRef = useRef<CropDragState | null>(null);
  const previewPanDragRef = useRef<PreviewPanDragState | null>(null);
  const pendingCropRectRef = useRef<CropRect | null>(null);
  const cropDragRafRef = useRef<number | null>(null);
  const pendingPreviewPanRef = useRef<{ panX: number; panY: number } | null>(null);
  const previewPanRafRef = useRef<number | null>(null);
  const pendingFrameStepCountRef = useRef(0);
  const isApplyingFrameStepRef = useRef(false);
  const splitterDragRef = useRef<SplitterDragState | null>(null);
  const previousWorkspaceSizeRef = useRef<{ width: number; height: number } | null>(null);
  const previousSelectedTimelineItemIdRef = useRef<string | null>(null);
  const previousCropEnabledRef = useRef(false);

  const trimRangeShellRef = useRef<HTMLDivElement>(null);
  const trimWindowDragRef = useRef<TrimWindowDragState | null>(null);
  const playheadDragRef = useRef<PlayheadDragState | null>(null);
  const previousTimelineDurationRef = useRef(0);
  const skipTrimRescaleRef = useRef(false);

  const clipById = useMemo(() => {
    return new Map(clips.map((clip) => [clip.id, clip]));
  }, [clips]);

  const largestClipResolution = useMemo(() => {
    return clips.reduce(
      (largest, clip) => {
        const area = clip.width * clip.height;
        if (area > largest.area) {
          return { area, width: clip.width, height: clip.height };
        }
        return largest;
      },
      { area: 0, width: 0, height: 0 }
    );
  }, [clips]);

  const timelineDisplayItems = useMemo(() => {
    return buildTimelineDisplayItems(timelineItems);
  }, [timelineItems]);

  const timelineDurationSec =
    timelineDisplayItems.length > 0
      ? timelineDisplayItems[timelineDisplayItems.length - 1].timelineEnd
      : 0;

  const editedSegments = useMemo(
    () => buildEditedSegments(timelineDisplayItems, trimStartSec, trimEndSec),
    [timelineDisplayItems, trimStartSec, trimEndSec]
  );
  const previewTimelineSegments = useMemo(
    () => buildEditedSegments(timelineDisplayItems, 0, timelineDurationSec),
    [timelineDisplayItems, timelineDurationSec]
  );

  const previewDurationSec =
    previewTimelineSegments.length > 0
      ? previewTimelineSegments[previewTimelineSegments.length - 1].editedEnd
      : 0;
  const hasEditedResolutionMismatch = useMemo(() => {
    if (editedSegments.length <= 1) {
      return false;
    }

    const resolutionKeys = new Set<string>();
    for (const segment of editedSegments) {
      const clip = clipById.get(segment.clipId);
      if (!clip) {
        continue;
      }

      resolutionKeys.add(`${clip.width}x${clip.height}`);
      if (resolutionKeys.size > 1) {
        return true;
      }
    }

    return false;
  }, [clipById, editedSegments]);
  const requestedWorkspaceWidth = useMemo(() => {
    const value = exportWidthInput.trim();
    if (value === "") {
      return null;
    }
    const parsed = parsePositiveIntegerInput(value);
    if (!parsed || parsed < 2) {
      return null;
    }
    return parsed;
  }, [exportWidthInput]);
  const requestedWorkspaceHeight = useMemo(() => {
    const value = exportHeightInput.trim();
    if (value === "") {
      return null;
    }
    const parsed = parsePositiveIntegerInput(value);
    if (!parsed || parsed < 2) {
      return null;
    }
    return parsed;
  }, [exportHeightInput]);
  const hasCustomWorkspace =
    requestedWorkspaceWidth !== null && requestedWorkspaceHeight !== null;
  const workspaceWidth = hasCustomWorkspace
    ? requestedWorkspaceWidth
    : largestClipResolution.width > 0
      ? largestClipResolution.width
      : 1280;
  const workspaceHeight = hasCustomWorkspace
    ? requestedWorkspaceHeight
    : largestClipResolution.height > 0
      ? largestClipResolution.height
      : 720;
  const requestedExportFps = useMemo(() => {
    const value = exportFpsInput.trim();
    if (value === "") {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
      return null;
    }
    return Math.round(parsed);
  }, [exportFpsInput]);
  const exportFormatConfig = useMemo(() => getExportFormatConfig(exportFormat), [exportFormat]);
  const exportSupportsVideo = exportFormatConfig.supportsVideo;
  const exportSupportsAudio = exportFormatConfig.supportsAudio;
  const effectiveIncludeVideo = exportSupportsVideo
    ? exportSupportsAudio
      ? includeVideoInExport
      : true
    : false;
  const effectiveIncludeAudio = exportSupportsAudio
    ? exportSupportsVideo
      ? includeAudioInExport
      : true
    : false;
  const frameReadoutFps = requestedExportFps ?? 30;
  const isFrameReadoutEstimated = requestedExportFps === null;
  const totalPreviewFrames = Math.max(0, Math.round(previewDurationSec * frameReadoutFps));
  const currentPreviewFrame =
    totalPreviewFrames > 0
      ? clamp(Math.floor(previewPositionSec * frameReadoutFps), 0, totalPreviewFrames)
      : 0;

  const minTrimGapSec = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);

  const trimStartPercent =
    timelineDurationSec > 0
      ? (clamp(trimStartSec, 0, timelineDurationSec) / timelineDurationSec) * 100
      : 0;
  const trimEndPercent =
    timelineDurationSec > 0
      ? (clamp(trimEndSec, 0, timelineDurationSec) / timelineDurationSec) * 100
      : 0;
  const trimRightPercent = Math.max(0, 100 - trimEndPercent);

  const playheadRawSec = useMemo(
    () => clamp(previewPositionSec, 0, timelineDurationSec),
    [previewPositionSec, timelineDurationSec]
  );

  const playheadPercent =
    timelineDurationSec > 0 ? (clamp(playheadRawSec, 0, timelineDurationSec) / timelineDurationSec) * 100 : 0;

  const selectedTimelineItem = selectedTimelineItemId
    ? timelineDisplayItems.find((item) => item.id === selectedTimelineItemId) ?? null
    : null;
  const selectedSpeedSliderValue = selectedTimelineItem
    ? speedToLogSliderValue(selectedTimelineItem.speed)
    : 0;
  const selectedScaleSliderValue = selectedTimelineItem
    ? scaleToLogSliderValue(selectedTimelineItem.scale)
    : 0;

  const isBusy = isIngesting || isExporting;
  const disableVideoToggle = isBusy || !exportSupportsVideo || !exportSupportsAudio;
  const disableAudioToggle = isBusy || !exportSupportsAudio || !exportSupportsVideo;
  const exportProgressValue = Math.min(
    1,
    Math.max(0, exportFrameProgress?.percent ?? exportProgress)
  );
  const exportProgressPercentText = `${(exportProgressValue * 100).toFixed(2)}%`;
  const exportFrameCountText =
    exportFrameProgress && exportFrameProgress.totalFrames > 0
      ? `${exportFrameProgress.currentFrame.toLocaleString()} / ${exportFrameProgress.totalFrames.toLocaleString()} frames`
      : null;
  const exportElapsedSec =
    exportStartedAtMs !== null ? Math.max(0, (exportNowMs - exportStartedAtMs) / 1000) : null;
  const exportEtaSec =
    isExporting &&
    exportElapsedSec !== null &&
    exportProgressValue >= 0.005 &&
    exportProgressValue < 1
      ? Math.max(0, exportElapsedSec / exportProgressValue - exportElapsedSec)
      : null;
  const exportEtaText =
    isExporting && exportProgressValue < 1
      ? exportEtaSec === null
        ? "ETA --:--"
        : `ETA ${formatEta(exportEtaSec)}`
      : null;
  const autoResolutionLabel =
    largestClipResolution.area > 0
      ? `${largestClipResolution.width} x ${largestClipResolution.height}`
      : "none";
  const totalSourceDurationSec = useMemo(
    () => clips.reduce((sum, clip) => sum + clip.duration, 0),
    [clips]
  );
  const effectiveLeftPaneWidth = isDesktopViewport && isLeftPanelCollapsed ? COLLAPSED_PANEL_WIDTH_PX : workspacePaneSizes.left;
  const effectiveRightPaneWidth =
    isDesktopViewport && isRightPanelCollapsed ? COLLAPSED_PANEL_WIDTH_PX : workspacePaneSizes.right;
  const workstationStyle: CSSProperties = {
    "--workspace-left": `${effectiveLeftPaneWidth}px`,
    "--workspace-right": `${effectiveRightPaneWidth}px`,
    "--workspace-splitter-left": isDesktopViewport && isLeftPanelCollapsed ? "0px" : "8px",
    "--workspace-splitter-right": isDesktopViewport && isRightPanelCollapsed ? "0px" : "8px"
  } as CSSProperties;
  const previewClips = useMemo<PreviewClip[]>(
    () =>
      clips.map((clip) => ({
        id: clip.id,
        file: clip.file,
        width: clip.width,
        height: clip.height
      })),
    [clips]
  );
  const previewSegments = useMemo<PreviewSegment[]>(
    () =>
      previewTimelineSegments.map((segment) => ({
        id: segment.id,
        clipId: segment.clipId,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        speed: segment.speed,
        scale:
          selectedTimelineItemId !== null && segment.timelineItemId === selectedTimelineItemId
            ? segment.scale
            : 1,
        panX:
          selectedTimelineItemId !== null && segment.timelineItemId === selectedTimelineItemId
            ? segment.panX
            : 0,
        panY:
          selectedTimelineItemId !== null && segment.timelineItemId === selectedTimelineItemId
            ? segment.panY
            : 0,
        editedStart: segment.editedStart,
        editedEnd: segment.editedEnd
      })),
    [previewTimelineSegments, selectedTimelineItemId]
  );
  const normalizedCropRect = useMemo(
    () => normalizeCropRect(cropRect, workspaceWidth, workspaceHeight),
    [cropRect, workspaceWidth, workspaceHeight]
  );
  const cropRectPercent = {
    left: workspaceWidth > 0 ? (normalizedCropRect.x / workspaceWidth) * 100 : 0,
    top: workspaceHeight > 0 ? (normalizedCropRect.y / workspaceHeight) * 100 : 0,
    width: workspaceWidth > 0 ? (normalizedCropRect.width / workspaceWidth) * 100 : 100,
    height: workspaceHeight > 0 ? (normalizedCropRect.height / workspaceHeight) * 100 : 100
  };
  const cropMaskPercent = {
    right: Math.max(0, 100 - cropRectPercent.left - cropRectPercent.width),
    bottom: Math.max(0, 100 - cropRectPercent.top - cropRectPercent.height)
  };

  function flushPendingCropRect(): void {
    if (cropDragRafRef.current !== null) {
      window.cancelAnimationFrame(cropDragRafRef.current);
      cropDragRafRef.current = null;
    }
    const pendingRect = pendingCropRectRef.current;
    pendingCropRectRef.current = null;
    if (!pendingRect) {
      return;
    }
    setCropRect((previous) => {
      if (
        previous.x === pendingRect.x &&
        previous.y === pendingRect.y &&
        previous.width === pendingRect.width &&
        previous.height === pendingRect.height
      ) {
        return previous;
      }
      return pendingRect;
    });
  }

  function scheduleCropRectUpdate(nextRect: CropRect): void {
    pendingCropRectRef.current = nextRect;
    if (cropDragRafRef.current !== null) {
      return;
    }
    cropDragRafRef.current = window.requestAnimationFrame(() => {
      cropDragRafRef.current = null;
      const pendingRect = pendingCropRectRef.current;
      pendingCropRectRef.current = null;
      if (!pendingRect) {
        return;
      }
      setCropRect((previous) => {
        if (
          previous.x === pendingRect.x &&
          previous.y === pendingRect.y &&
          previous.width === pendingRect.width &&
          previous.height === pendingRect.height
        ) {
          return previous;
        }
        return pendingRect;
      });
    });
  }

  function flushPendingPreviewPan(): void {
    if (previewPanRafRef.current !== null) {
      window.cancelAnimationFrame(previewPanRafRef.current);
      previewPanRafRef.current = null;
    }
    const pendingPan = pendingPreviewPanRef.current;
    pendingPreviewPanRef.current = null;
    if (!pendingPan) {
      return;
    }
    setSelectedTimelineTransform({
      panX: pendingPan.panX,
      panY: pendingPan.panY
    });
  }

  function schedulePreviewPanUpdate(nextPan: { panX: number; panY: number }): void {
    pendingPreviewPanRef.current = nextPan;
    if (previewPanRafRef.current !== null) {
      return;
    }
    previewPanRafRef.current = window.requestAnimationFrame(() => {
      previewPanRafRef.current = null;
      const pendingPan = pendingPreviewPanRef.current;
      pendingPreviewPanRef.current = null;
      if (!pendingPan) {
        return;
      }
      setSelectedTimelineTransform({
        panX: pendingPan.panX,
        panY: pendingPan.panY
      });
    });
  }

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    return () => {
      for (const clip of clipsRef.current) {
        URL.revokeObjectURL(clip.url);
      }
      if (cropDragRafRef.current !== null) {
        window.cancelAnimationFrame(cropDragRafRef.current);
        cropDragRafRef.current = null;
      }
      if (previewPanRafRef.current !== null) {
        window.cancelAnimationFrame(previewPanRafRef.current);
        previewPanRafRef.current = null;
      }
      pendingCropRectRef.current = null;
      pendingPreviewPanRef.current = null;
    };
  }, []);

  useEffect(() => {
    previewSegmentsRef.current = previewTimelineSegments;
  }, [previewTimelineSegments]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = (): void => {
      setIsDesktopViewport(isDesktopViewportWidth(window.innerWidth));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const payload: PersistedLayoutV1 = {
      left: workspacePaneSizes.left,
      right: workspacePaneSizes.right,
      dockTab,
      leftCollapsed: isLeftPanelCollapsed,
      rightCollapsed: isRightPanelCollapsed
    };

    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore persistence errors (private mode, quota, etc.)
    }
  }, [
    dockTab,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    workspacePaneSizes.left,
    workspacePaneSizes.right
  ]);

  useEffect(() => {
    if (!isDesktopViewport && activeSplitter !== null) {
      splitterDragRef.current = null;
      setActiveSplitter(null);
    }
  }, [activeSplitter, isDesktopViewport]);

  useEffect(() => {
    if (
      (isLeftPanelCollapsed && activeSplitter === "left") ||
      (isRightPanelCollapsed && activeSplitter === "right")
    ) {
      splitterDragRef.current = null;
      setActiveSplitter(null);
    }
  }, [activeSplitter, isLeftPanelCollapsed, isRightPanelCollapsed]);

  useEffect(() => {
    const previousSelected = previousSelectedTimelineItemIdRef.current;
    if (selectedTimelineItemId && selectedTimelineItemId !== previousSelected) {
      setInspectorOpenState((previous) => ({
        ...previous,
        segment: true,
        speed: true,
        transform: true
      }));
    }
    previousSelectedTimelineItemIdRef.current = selectedTimelineItemId;
  }, [selectedTimelineItemId]);

  useEffect(() => {
    const wasEnabled = previousCropEnabledRef.current;
    if (cropEnabled && !wasEnabled) {
      setInspectorOpenState((previous) => ({
        ...previous,
        crop: true
      }));
    }
    previousCropEnabledRef.current = cropEnabled;
  }, [cropEnabled]);

  useEffect(() => {
    if (activeSplitter === null || !isDesktopViewport) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = splitterDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      event.preventDefault();

      let nextSizes = drag.startSizes;
      if (drag.splitter === "left") {
        const deltaX = event.clientX - drag.startClientX;
        nextSizes = {
          ...drag.startSizes,
          left: drag.startSizes.left + deltaX
        };
      } else {
        const deltaX = event.clientX - drag.startClientX;
        nextSizes = {
          ...drag.startSizes,
          right: drag.startSizes.right - deltaX
        };
      }

      setWorkspacePaneSizes(clampPaneSizes(nextSizes));
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = splitterDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      splitterDragRef.current = null;
      setActiveSplitter(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [activeSplitter, isDesktopViewport]);

  useEffect(() => {
    setCropRect((previous) => {
      const previousWorkspace = previousWorkspaceSizeRef.current;
      if (!previousWorkspace || previousWorkspace.width <= 0 || previousWorkspace.height <= 0) {
        return normalizeCropRect(
          {
            x: 0,
            y: 0,
            width: workspaceWidth,
            height: workspaceHeight
          },
          workspaceWidth,
          workspaceHeight
        );
      }

      if (
        previousWorkspace.width === workspaceWidth &&
        previousWorkspace.height === workspaceHeight
      ) {
        return normalizeCropRect(previous, workspaceWidth, workspaceHeight);
      }

      const next = {
        x: Math.round((previous.x / previousWorkspace.width) * workspaceWidth),
        y: Math.round((previous.y / previousWorkspace.height) * workspaceHeight),
        width: Math.round((previous.width / previousWorkspace.width) * workspaceWidth),
        height: Math.round((previous.height / previousWorkspace.height) * workspaceHeight)
      };
      return normalizeCropRect(next, workspaceWidth, workspaceHeight);
    });

    previousWorkspaceSizeRef.current = {
      width: workspaceWidth,
      height: workspaceHeight
    };
  }, [workspaceWidth, workspaceHeight]);

  useEffect(() => {
    if (!cropLockAspect || normalizedCropRect.height <= 0) {
      return;
    }
    const nextRatio = normalizedCropRect.width / normalizedCropRect.height;
    setCropAspectRatio((previous) => (nearlyEqual(previous, nextRatio) ? previous : nextRatio));
  }, [cropLockAspect, normalizedCropRect.height, normalizedCropRect.width]);

  useEffect(() => {
    if (!exportSupportsVideo || !hasEditedResolutionMismatch) {
      return;
    }

    setExportMode((previous) => (previous === "fit" ? previous : "fit"));
  }, [exportSupportsVideo, hasEditedResolutionMismatch]);

  useEffect(() => {
    if (!isExporting) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setExportNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isExporting]);

  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }

    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return;
    }

    const engine = new TimelinePreviewEngine(canvas, {
      onTimeUpdate: (timeSec) => {
        setPreviewPositionSec((previous) => {
          const minStep = isPlayingRef.current ? PREVIEW_UI_POSITION_STEP_SEC : 0.000001;
          if (Math.abs(previous - timeSec) < minStep) {
            return previous;
          }
          return timeSec;
        });

        const currentSegments = previewSegmentsRef.current;
        if (currentSegments.length === 0) {
          setCurrentSegmentIndex(0);
          return;
        }

        const upperBound = Math.max(0, currentSegments[currentSegments.length - 1].editedEnd - 0.0001);
        const bounded = clamp(timeSec, 0, upperBound);
        const nextIndex = Math.max(0, findSegmentIndex(currentSegments, bounded));
        setCurrentSegmentIndex((previous) => (previous === nextIndex ? previous : nextIndex));
      },
      onPlayStateChange: (playing) => {
        isPlayingRef.current = playing;
        setIsPlaying(playing);
      },
      onError: (message) => {
        setError(message);
      }
    });

    previewEngineRef.current = engine;

    return () => {
      engine.destroy();
      if (previewEngineRef.current === engine) {
        previewEngineRef.current = null;
      }
    };
  }, [isPreviewSupported]);

  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }

    const engine = previewEngineRef.current;
    if (!engine) {
      return;
    }

    const currentPosition = engine.getPositionSec();
    void engine.setProject(previewClips, previewSegments, currentPosition, {
      width: workspaceWidth,
      height: workspaceHeight
    });
  }, [isPreviewSupported, previewClips, previewSegments, workspaceHeight, workspaceWidth]);

  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }
    const engine = previewEngineRef.current;
    if (!engine || previewTimelineSegments.length === 0) {
      return;
    }
    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const bounded = clamp(engine.getPositionSec(), 0, upperBound);
    engine.seek(bounded);
  }, [
    dockTab,
    isLeftPanelCollapsed,
    isPreviewSupported,
    isRightPanelCollapsed,
    previewDurationSec,
    previewTimelineSegments.length,
    workspacePaneSizes.left,
    workspacePaneSizes.right
  ]);

  useEffect(() => {
    if (selectedTimelineItemId && !timelineItems.some((item) => item.id === selectedTimelineItemId)) {
      setSelectedTimelineItemId(null);
    }
  }, [selectedTimelineItemId, timelineItems]);

  useEffect(() => {
    if (draggingTimelineItemId && !timelineItems.some((item) => item.id === draggingTimelineItemId)) {
      setDraggingTimelineItemId(null);
    }
  }, [draggingTimelineItemId, timelineItems]);

  useEffect(() => {
    if (!selectedTimelineItem) {
      setSelectedSpeedInput((previous) => (previous === "" ? previous : ""));
      setSelectedDurationMinutesInput((previous) => (previous === "" ? previous : ""));
      setSelectedDurationSecondsInput((previous) => (previous === "" ? previous : ""));
      setSelectedDurationMillisecondsInput((previous) => (previous === "" ? previous : ""));
      setSelectedScaleInput((previous) => (previous === "" ? previous : ""));
      setSelectedPanXInput((previous) => (previous === "" ? previous : ""));
      setSelectedPanYInput((previous) => (previous === "" ? previous : ""));
      return;
    }

    if (isDraggingPreviewPan) {
      return;
    }

    const durationParts = durationPartsFromSeconds(selectedTimelineItem.duration);
    const nextSpeed = formatSpeedLabel(selectedTimelineItem.speed);
    const nextMinutes = durationParts.minutes.toString();
    const nextSeconds = durationParts.seconds.toString();
    const nextMilliseconds = durationParts.milliseconds.toString();
    const nextScale = formatScaleLabel(selectedTimelineItem.scale);
    const nextPanX = normalizePanValue(selectedTimelineItem.panX).toString();
    const nextPanY = normalizePanValue(selectedTimelineItem.panY).toString();

    setSelectedSpeedInput((previous) => (previous === nextSpeed ? previous : nextSpeed));
    setSelectedDurationMinutesInput((previous) => (previous === nextMinutes ? previous : nextMinutes));
    setSelectedDurationSecondsInput((previous) => (previous === nextSeconds ? previous : nextSeconds));
    setSelectedDurationMillisecondsInput((previous) =>
      previous === nextMilliseconds ? previous : nextMilliseconds
    );
    setSelectedScaleInput((previous) => (previous === nextScale ? previous : nextScale));
    setSelectedPanXInput((previous) => (previous === nextPanX ? previous : nextPanX));
    setSelectedPanYInput((previous) => (previous === nextPanY ? previous : nextPanY));
  }, [
    isDraggingPreviewPan,
    selectedTimelineItemId,
    selectedTimelineItem?.speed,
    selectedTimelineItem?.duration,
    selectedTimelineItem?.scale,
    selectedTimelineItem?.panX,
    selectedTimelineItem?.panY
  ]);

  // Reposition playback when timeline structure changes.
  useEffect(() => {
    if (previewTimelineSegments.length === 0) {
      previewEngineRef.current?.pause();
      setCurrentSegmentIndex(0);
      setPreviewPositionSec(0);
      setIsPlaying(false);
      return;
    }

    const engine = previewEngineRef.current;
    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const currentPosition = engine?.getPositionSec() ?? previewPositionSec;
    const clampedPosition = clamp(currentPosition, 0, upperBound);
    const nextSegmentIndex = Math.max(0, findSegmentIndex(previewTimelineSegments, clampedPosition));
    engine?.pause();
    setIsPlaying(false);
    setPreviewPositionSec((previous) => (nearlyEqual(previous, clampedPosition) ? previous : clampedPosition));
    setCurrentSegmentIndex((previous) => (previous === nextSegmentIndex ? previous : nextSegmentIndex));
    engine?.seek(clampedPosition);
  }, [previewDurationSec, previewTimelineSegments]);

  // Keep trim window visual coverage stable when timeline duration changes (e.g. speed edits).
  useEffect(() => {
    const previousDuration = previousTimelineDurationRef.current;
    previousTimelineDurationRef.current = timelineDurationSec;

    if (skipTrimRescaleRef.current) {
      skipTrimRescaleRef.current = false;
      return;
    }

    if (
      previousDuration <= 0 ||
      timelineDurationSec <= 0 ||
      nearlyEqual(previousDuration, timelineDurationSec)
    ) {
      return;
    }

    const startRatio = clamp(trimStartSec / previousDuration, 0, 1);
    const endRatio = clamp(trimEndSec / previousDuration, startRatio, 1);

    let nextStart = startRatio * timelineDurationSec;
    let nextEnd = endRatio * timelineDurationSec;

    const gap = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);
    if (nextEnd - nextStart < gap) {
      const center = (nextStart + nextEnd) / 2;
      nextStart = clamp(center - gap / 2, 0, Math.max(0, timelineDurationSec - gap));
      nextEnd = nextStart + gap;
    }

    if (!nearlyEqual(nextStart, trimStartSec)) {
      setTrimStartSec(nextStart);
    }
    if (!nearlyEqual(nextEnd, trimEndSec)) {
      setTrimEndSec(nextEnd);
    }
  }, [timelineDurationSec, trimEndSec, trimStartSec]);

  useEffect(() => {
    if (timelineDurationSec <= 0) {
      if (!nearlyEqual(trimStartSec, 0)) {
        setTrimStartSec(0);
      }
      if (!nearlyEqual(trimEndSec, 0)) {
        setTrimEndSec(0);
      }
      return;
    }

    const gap = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);
    const maxStart = Math.max(0, timelineDurationSec - gap);
    const boundedStart = clamp(trimStartSec, 0, maxStart);

    if (!nearlyEqual(boundedStart, trimStartSec)) {
      setTrimStartSec(boundedStart);
      return;
    }

    const minEnd = Math.min(timelineDurationSec, boundedStart + gap);
    const boundedEnd = clamp(trimEndSec, minEnd, timelineDurationSec);
    if (!nearlyEqual(boundedEnd, trimEndSec)) {
      setTrimEndSec(boundedEnd);
    }
  }, [timelineDurationSec, trimEndSec, trimStartSec]);

  useEffect(() => {
    if (!isDraggingTrimEdge) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = trimWindowDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      if (drag.railWidthPx <= 0 || timelineDurationSec <= 0) {
        return;
      }

      event.preventDefault();

      const deltaSec =
        ((event.clientX - drag.startClientX) / drag.railWidthPx) * timelineDurationSec;
      if (drag.mode === "start") {
        const nextRaw = drag.initialStartSec + deltaSec;
        const nextValue = event.altKey
          ? nextRaw
          : snapTimelineValueToTargets(
              nextRaw,
              [playheadRawSec],
              drag.railWidthPx,
              timelineDurationSec
            );
        applyTrimStart(nextValue);
      } else {
        const nextRaw = drag.initialEndSec + deltaSec;
        const nextValue = event.altKey
          ? nextRaw
          : snapTimelineValueToTargets(
              nextRaw,
              [playheadRawSec],
              drag.railWidthPx,
              timelineDurationSec
            );
        applyTrimEnd(nextValue);
      }
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = trimWindowDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      trimWindowDragRef.current = null;
      setIsDraggingTrimEdge(false);
      setActiveTrimEdge(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [isDraggingTrimEdge, playheadRawSec, timelineDurationSec]);

  useEffect(() => {
    if (!isDraggingTrimEdge) {
      return;
    }

    if (isBusy || timelineDurationSec <= 0) {
      trimWindowDragRef.current = null;
      setIsDraggingTrimEdge(false);
      setActiveTrimEdge(null);
    }
  }, [isBusy, isDraggingTrimEdge, timelineDurationSec]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      const isArrowLeft = event.key === "ArrowLeft";
      const isArrowRight = event.key === "ArrowRight";
      const isFrameStep = isArrowLeft || isArrowRight;
      const isSpace =
        event.code === "Space" || event.key === " " || event.key === "Spacebar";
      if ((!isSpace && !isFrameStep) || event.defaultPrevented) {
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isKeyboardEventFromInteractiveElement(event.target)) {
        return;
      }

      if (!previewEngineRef.current || previewSegmentsRef.current.length === 0) {
        return;
      }

      event.preventDefault();
      if (isSpace) {
        if (event.repeat || event.shiftKey) {
          return;
        }
        togglePlayPauseRef.current();
        return;
      }

      stepPreviewFrameRef.current(isArrowRight ? 1 : -1);
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!isDraggingPlayhead) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = playheadDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      if (drag.railWidthPx <= 0 || timelineDurationSec <= 0) {
        return;
      }

      event.preventDefault();
      const ratio = clamp((event.clientX - drag.railLeftPx) / drag.railWidthPx, 0, 1);
      const rawPosition = ratio * timelineDurationSec;
      const nextPosition = event.altKey
        ? rawPosition
        : snapTimelineValueToTargets(
            rawPosition,
            [trimStartSec, trimEndSec],
            drag.railWidthPx,
            timelineDurationSec
          );
      seekToTimelinePosition(nextPosition, false);
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = playheadDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      playheadDragRef.current = null;
      setIsDraggingPlayhead(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [isDraggingPlayhead, timelineDurationSec, trimEndSec, trimStartSec]);

  useEffect(() => {
    if (!isDraggingPlayhead) {
      return;
    }

    if (isBusy || timelineDurationSec <= 0) {
      playheadDragRef.current = null;
      setIsDraggingPlayhead(false);
    }
  }, [isBusy, isDraggingPlayhead, timelineDurationSec]);

  useEffect(() => {
    if (!isDraggingCrop) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = cropDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      event.preventDefault();
      const nextRect = applyCropDrag(
        drag,
        event.clientX,
        event.clientY,
        cropLockAspect,
        cropAspectRatio
      );
      scheduleCropRectUpdate(nextRect);
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = cropDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      flushPendingCropRect();
      cropDragRef.current = null;
      setIsDraggingCrop(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      if (cropDragRafRef.current !== null) {
        window.cancelAnimationFrame(cropDragRafRef.current);
        cropDragRafRef.current = null;
      }
      pendingCropRectRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [cropAspectRatio, cropLockAspect, isDraggingCrop]);

  useEffect(() => {
    if (!isDraggingCrop) {
      return;
    }

    if (isBusy || !cropEnabled || clips.length === 0) {
      flushPendingCropRect();
      cropDragRef.current = null;
      setIsDraggingCrop(false);
    }
  }, [clips.length, cropEnabled, isBusy, isDraggingCrop]);

  useEffect(() => {
    if (!isDraggingPreviewPan) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = previewPanDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      event.preventDefault();
      const deltaX =
        ((event.clientX - drag.startClientX) / Math.max(1, drag.overlayWidthPx)) * drag.workspaceWidth;
      const deltaY =
        ((event.clientY - drag.startClientY) / Math.max(1, drag.overlayHeightPx)) * drag.workspaceHeight;
      const rawPanX = drag.initialPanX + deltaX;
      const rawPanY = drag.initialPanY + deltaY;
      const snapped = event.shiftKey
        ? { panX: rawPanX, panY: rawPanY }
        : snapPanToCropEdges(
            rawPanX,
            rawPanY,
            drag.baseX,
            drag.baseY,
            drag.drawWidth,
            drag.drawHeight,
            drag.cropRect
          );
      schedulePreviewPanUpdate(snapped);
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = previewPanDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      flushPendingPreviewPan();
      previewPanDragRef.current = null;
      setIsDraggingPreviewPan(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      if (previewPanRafRef.current !== null) {
        window.cancelAnimationFrame(previewPanRafRef.current);
        previewPanRafRef.current = null;
      }
      pendingPreviewPanRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [isDraggingPreviewPan]);

  useEffect(() => {
    if (!isDraggingPreviewPan) {
      return;
    }

    if (isBusy || !cropEnabled || !selectedTimelineItem || clips.length === 0) {
      flushPendingPreviewPan();
      previewPanDragRef.current = null;
      setIsDraggingPreviewPan(false);
    }
  }, [clips.length, cropEnabled, isBusy, isDraggingPreviewPan, selectedTimelineItem]);

  function resetTimelineWindow(durationSec: number): void {
    skipTrimRescaleRef.current = true;
    previewEngineRef.current?.pause();
    previewEngineRef.current?.seek(0);
    setTrimStartSec(0);
    setTrimEndSec(durationSec);
    setPreviewPositionSec(0);
    setCurrentSegmentIndex(0);
    setIsPlaying(false);
    setSelectedTimelineItemId(null);
  }

  async function addVideos(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = Array.from(fileList).filter((file) => file.type.startsWith("video/"));
    if (files.length === 0) {
      setError("No valid video files were provided.");
      return;
    }

    setIsIngesting(true);
    setError(null);

    const nextClips: SourceClip[] = [];
    try {
      for (const file of files) {
        const url = URL.createObjectURL(file);
        try {
          const metadata = await loadVideoMetadata(url);
          if (metadata.duration <= 0) {
            throw new Error(`Could not read duration for \"${file.name}\".`);
          }

          nextClips.push({
            id: makeId(),
            file,
            url,
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height
          });
        } catch (metadataError) {
          URL.revokeObjectURL(url);
          throw metadataError;
        }
      }

      const appendedTimelineItems: TimelineItem[] = nextClips.map((clip) => ({
        id: makeId(),
        sourceClipId: clip.id,
        sourceStart: 0,
        sourceEnd: clip.duration,
        speed: 1,
        scale: 1,
        panX: 0,
        panY: 0
      }));

      const combinedClips = [...clips, ...nextClips];
      const combinedTimeline = [...timelineItems, ...appendedTimelineItems];

      setClips(combinedClips);
      setTimelineItems(combinedTimeline);
      resetTimelineWindow(timelineDurationFromItems(combinedTimeline));
    } catch (caughtError) {
      for (const clip of nextClips) {
        URL.revokeObjectURL(clip.url);
      }

      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to load one or more videos.";
      setError(message);
    } finally {
      setIsIngesting(false);
    }
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    await addVideos(event.target.files);
    event.target.value = "";
  }

  async function handleDrop(event: ReactDragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    await addVideos(event.dataTransfer.files);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }

  function removeClip(id: string): void {
    const clip = clips.find((item) => item.id === id);
    if (!clip) {
      return;
    }

    URL.revokeObjectURL(clip.url);

    const nextClips = clips.filter((item) => item.id !== id);
    const nextTimeline = timelineItems.filter((item) => item.sourceClipId !== id);

    setClips(nextClips);
    setTimelineItems(nextTimeline);
    resetTimelineWindow(timelineDurationFromItems(nextTimeline));
  }

  function clearQueue(): void {
    for (const clip of clips) {
      URL.revokeObjectURL(clip.url);
    }

    setClips([]);
    setTimelineItems([]);
    resetTimelineWindow(0);
    setError(null);
    setExportProgress(0);
    setExportFrameProgress(null);
    setExportStartedAtMs(null);
    setExportStage(null);
    setExportStatusMessage(null);
    setDraggingTimelineItemId(null);
    setCropEnabled(false);
    setCropRect({
      x: 0,
      y: 0,
      width: 1280,
      height: 720
    });
    previousWorkspaceSizeRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function seekToPreviewPosition(targetSec: number, autoPlay: boolean): void {
    if (previewTimelineSegments.length === 0) {
      return;
    }

    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const clamped = clamp(targetSec, 0, upperBound);
    const nextIndex = findSegmentIndex(previewTimelineSegments, clamped);
    if (nextIndex < 0) {
      return;
    }

    setPreviewPositionSec(clamped);
    setCurrentSegmentIndex(nextIndex);

    const engine = previewEngineRef.current;
    if (!engine) {
      return;
    }

    if (!autoPlay && isPlayingRef.current) {
      engine.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    }

    engine.seek(clamped);
    if (autoPlay) {
      void engine.play().catch(() => {
        setError("Unable to start playback. Interact with the page and try again.");
      });
      return;
    }
  }

  function seekToTimelinePosition(rawPositionSec: number, autoPlay: boolean): void {
    if (previewTimelineSegments.length === 0 || timelineDurationSec <= 0) {
      return;
    }

    const boundedRaw = clamp(rawPositionSec, 0, timelineDurationSec);
    seekToPreviewPosition(boundedRaw, autoPlay);
  }

  function startFrameStepDrain(): void {
    if (isApplyingFrameStepRef.current) {
      return;
    }

    isApplyingFrameStepRef.current = true;
    void (async () => {
      try {
        while (pendingFrameStepCountRef.current !== 0) {
          const engine = previewEngineRef.current;
          if (!engine || previewTimelineSegments.length === 0) {
            pendingFrameStepCountRef.current = 0;
            break;
          }

          const nextDirection: -1 | 1 = pendingFrameStepCountRef.current > 0 ? 1 : -1;
          pendingFrameStepCountRef.current -= nextDirection;

          if (isPlayingRef.current) {
            engine.pause();
            isPlayingRef.current = false;
            setIsPlaying(false);
          }

          const stepFps = Math.max(1, frameReadoutFps);
          const upperBound = Math.max(0, previewDurationSec - 0.0001);
          const maxFrame = Math.max(0, Math.floor(upperBound * stepFps));
          const currentSec = clamp(engine.getPositionSec(), 0, upperBound);
          const currentFrame = clamp(Math.floor(currentSec * stepFps), 0, maxFrame);
          const targetFrame = clamp(currentFrame + nextDirection, 0, maxFrame);
          if (targetFrame === currentFrame) {
            continue;
          }

          const targetSec = clamp(targetFrame / stepFps + 0.25 / stepFps, 0, upperBound);
          await engine.seekAndRender(targetSec);

          const boundedNext = clamp(engine.getPositionSec(), 0, upperBound);
          const nextIndex = findSegmentIndex(previewTimelineSegments, boundedNext);
          if (nextIndex < 0) {
            continue;
          }

          setPreviewPositionSec(boundedNext);
          setCurrentSegmentIndex(nextIndex);
        }
      } finally {
        isApplyingFrameStepRef.current = false;
        if (pendingFrameStepCountRef.current !== 0) {
          startFrameStepDrain();
        }
      }
    })();
  }

  function stepPreviewFrame(direction: -1 | 1): void {
    if (previewTimelineSegments.length === 0) {
      return;
    }

    pendingFrameStepCountRef.current += direction;
    startFrameStepDrain();
  }

  function applyTrimStart(nextValueSec: number): void {
    const maxStart = Math.max(0, trimEndSec - minTrimGapSec);
    const snapThreshold = TRIM_SNAP_STEP_SEC * 1.5;
    let bounded = clamp(nextValueSec, 0, maxStart);
    if (bounded <= snapThreshold) {
      bounded = 0;
    } else if (maxStart - bounded <= snapThreshold) {
      bounded = maxStart;
    }
    bounded = normalizeTimeValue(bounded);
    setTrimStartSec((previous) => (nearlyEqual(previous, bounded) ? previous : bounded));
  }

  function applyTrimEnd(nextValueSec: number): void {
    const minEnd = Math.min(timelineDurationSec, trimStartSec + minTrimGapSec);
    const snapThreshold = TRIM_SNAP_STEP_SEC * 1.5;
    let bounded = clamp(nextValueSec, minEnd, timelineDurationSec);
    if (timelineDurationSec - bounded <= snapThreshold) {
      bounded = timelineDurationSec;
    } else if (bounded - minEnd <= snapThreshold) {
      bounded = minEnd;
    }
    bounded = normalizeTimeValue(bounded);
    setTrimEndSec((previous) => (nearlyEqual(previous, bounded) ? previous : bounded));
  }

  async function togglePlayPause(): Promise<void> {
    const engine = previewEngineRef.current;
    if (!engine || previewTimelineSegments.length === 0) {
      return;
    }

    if (!isPlaying) {
      const currentPosition = engine.getPositionSec();
      if (currentPosition >= previewDurationSec - SEGMENT_END_EPSILON) {
        seekToPreviewPosition(0, false);
      }

      try {
        await engine.play();
      } catch {
        setError("Unable to start playback. Interact with the page and try again.");
      }
      return;
    }

    engine.pause();
    setIsPlaying(false);
  }
  togglePlayPauseRef.current = () => {
    void togglePlayPause();
  };
  stepPreviewFrameRef.current = stepPreviewFrame;

  function splitTimelineAt(rawPositionSec: number): void {
    if (timelineDisplayItems.length === 0 || timelineDurationSec <= 0) {
      return;
    }

    const bounded = clamp(rawPositionSec, 0, timelineDurationSec);
    const target = timelineDisplayItems.find(
      (item) =>
        bounded > item.timelineStart + MIN_EDIT_GAP_SEC &&
        bounded < item.timelineEnd - MIN_EDIT_GAP_SEC
    );

    if (!target) {
      setError("Place the razor inside a timeline piece (not on an edge).");
      return;
    }

    const splitSource = target.sourceStart + (bounded - target.timelineStart) * target.speed;
    const leftId = makeId();
    const rightId = makeId();

    setTimelineItems((previous) => {
      const index = previous.findIndex((item) => item.id === target.id);
      if (index < 0) {
        return previous;
      }

      const leftPiece: TimelineItem = {
        id: leftId,
        sourceClipId: target.sourceClipId,
        sourceStart: target.sourceStart,
        sourceEnd: splitSource,
        speed: target.speed,
        scale: target.scale,
        panX: target.panX,
        panY: target.panY
      };
      const rightPiece: TimelineItem = {
        id: rightId,
        sourceClipId: target.sourceClipId,
        sourceStart: splitSource,
        sourceEnd: target.sourceEnd,
        speed: target.speed,
        scale: target.scale,
        panX: target.panX,
        panY: target.panY
      };

      return [
        ...previous.slice(0, index),
        leftPiece,
        rightPiece,
        ...previous.slice(index + 1)
      ];
    });

    setSelectedTimelineItemId(rightId);
    setError(null);
  }

  function handleTimelineSegmentClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    item: TimelineDisplayItem
  ): void {
    if (isBusy) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawPosition = item.timelineStart + item.duration * ratio;

    setSelectedTimelineItemId(item.id);

    if (timelineTool === "razor") {
      splitTimelineAt(rawPosition);
      return;
    }

    seekToTimelinePosition(rawPosition, isPlaying);
  }

  function handleTrimEdgePointerDown(
    event: ReactPointerEvent<HTMLSpanElement>,
    mode: "start" | "end"
  ): void {
    if (event.button !== 0 || isBusy || timelineDurationSec <= 0 || trimEndSec <= trimStartSec) {
      return;
    }

    const rail = trimRangeShellRef.current;
    if (!rail) {
      return;
    }

    const railRect = rail.getBoundingClientRect();
    if (railRect.width <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    trimWindowDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      railWidthPx: railRect.width,
      initialStartSec: trimStartSec,
      initialEndSec: trimEndSec,
      mode
    };
    setActiveTrimEdge(mode);
    setIsDraggingTrimEdge(true);
  }

  function handlePlayheadPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (
      event.button !== 0 ||
      isBusy ||
      timelineDurationSec <= 0 ||
      previewTimelineSegments.length === 0
    ) {
      return;
    }

    const rail = trimRangeShellRef.current;
    if (!rail) {
      return;
    }

    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    previewEngineRef.current?.pause();
    setIsPlaying(false);

    playheadDragRef.current = {
      pointerId: event.pointerId,
      railLeftPx: rect.left,
      railWidthPx: rect.width
    };
    setIsDraggingPlayhead(true);

    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawPosition = ratio * timelineDurationSec;
    const nextPosition = event.altKey
      ? rawPosition
      : snapTimelineValueToTargets(
          rawPosition,
          [trimStartSec, trimEndSec],
          rect.width,
          timelineDurationSec
        );
    seekToTimelinePosition(nextPosition, false);
  }

  function handleTimelineItemDragStart(
    event: ReactDragEvent<HTMLButtonElement>,
    itemId: string
  ): void {
    if (isBusy) {
      event.preventDefault();
      return;
    }

    setDraggingTimelineItemId(itemId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function handleTimelineItemDragOver(event: ReactDragEvent<HTMLButtonElement>): void {
    if (!draggingTimelineItemId || isBusy) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleTimelineItemDrop(
    event: ReactDragEvent<HTMLButtonElement>,
    targetId: string
  ): void {
    if (!draggingTimelineItemId || isBusy) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;

    setTimelineItems((previous) =>
      moveTimelineItem(previous, draggingTimelineItemId, targetId, placeAfter)
    );
    setDraggingTimelineItemId(null);
  }

  function handleTimelineItemDragEnd(): void {
    setDraggingTimelineItemId(null);
  }

  function removeSelectedTimelinePiece(): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    setTimelineItems((previous) => previous.filter((item) => item.id !== selectedTimelineItemId));
    setSelectedTimelineItemId(null);
  }

  function setSelectedTimelineSpeed(nextSpeed: number): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    const clampedSpeed = clampSpeed(nextSpeed);
    setTimelineItems((previous) =>
      previous.map((item) =>
        item.id === selectedTimelineItemId
          ? {
              ...item,
              speed: clampedSpeed
            }
          : item
      )
    );
    setError(null);
  }

  function applySelectedDurationInputs(
    minutesText: string,
    secondsText: string,
    millisecondsText: string,
    forceResetOnInvalid: boolean
  ): void {
    if (!selectedTimelineItem) {
      return;
    }

    const minutes = parseNonNegativeIntegerInput(minutesText);
    const seconds = parseNonNegativeIntegerInput(secondsText);
    const milliseconds = parseNonNegativeIntegerInput(millisecondsText);

    if (minutes === null || seconds === null || milliseconds === null) {
      if (forceResetOnInvalid) {
        const fallback = durationPartsFromSeconds(selectedTimelineItem.duration);
        setSelectedDurationMinutesInput(fallback.minutes.toString());
        setSelectedDurationSecondsInput(fallback.seconds.toString());
        setSelectedDurationMillisecondsInput(fallback.milliseconds.toString());
      }
      return;
    }

    const totalMilliseconds = minutes * 60000 + seconds * 1000 + milliseconds;
    if (totalMilliseconds <= 0) {
      if (forceResetOnInvalid) {
        const fallback = durationPartsFromSeconds(selectedTimelineItem.duration);
        setSelectedDurationMinutesInput(fallback.minutes.toString());
        setSelectedDurationSecondsInput(fallback.seconds.toString());
        setSelectedDurationMillisecondsInput(fallback.milliseconds.toString());
      }
      return;
    }

    const sourceDuration = Math.max(
      0,
      selectedTimelineItem.sourceEnd - selectedTimelineItem.sourceStart
    );
    if (sourceDuration <= 0) {
      return;
    }

    const targetDuration = totalMilliseconds / 1000;
    const clampedSpeed = clampSpeed(sourceDuration / targetDuration);
    setSelectedTimelineSpeed(clampedSpeed);
  }

  function setSelectedTimelineTransform(next: {
    scale?: number;
    panX?: number;
    panY?: number;
  }): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    setTimelineItems((previous) => {
      let hasChanged = false;
      const nextItems = previous.map((item) => {
        if (item.id !== selectedTimelineItemId) {
          return item;
        }

        const nextScale =
          next.scale === undefined ? clampPieceScale(item.scale) : clampPieceScale(next.scale);
        const nextPanX = next.panX === undefined ? item.panX : normalizePanValue(next.panX);
        const nextPanY = next.panY === undefined ? item.panY : normalizePanValue(next.panY);

        if (
          nearlyEqual(nextScale, item.scale) &&
          nearlyEqual(nextPanX, item.panX) &&
          nearlyEqual(nextPanY, item.panY)
        ) {
          return item;
        }

        hasChanged = true;
        return {
          ...item,
          scale: nextScale,
          panX: nextPanX,
          panY: nextPanY
        };
      });

      return hasChanged ? nextItems : previous;
    });
    setError((previous) => (previous === null ? previous : null));
  }

  function handleSelectedSpeedInputChange(value: string): void {
    setSelectedSpeedInput(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    setSelectedTimelineSpeed(parsed);
  }

  function commitSelectedSpeedInput(): void {
    if (!selectedTimelineItem) {
      return;
    }
    const parsed = Number(selectedSpeedInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSelectedSpeedInput(formatSpeedLabel(selectedTimelineItem.speed));
      return;
    }
    const clampedSpeed = clampSpeed(parsed);
    setSelectedTimelineSpeed(clampedSpeed);
    setSelectedSpeedInput(formatSpeedLabel(clampedSpeed));
  }

  function handleSelectedDurationInputChange(
    part: "minutes" | "seconds" | "milliseconds",
    value: string
  ): void {
    const nextMinutes = part === "minutes" ? value : selectedDurationMinutesInput;
    const nextSeconds = part === "seconds" ? value : selectedDurationSecondsInput;
    const nextMilliseconds =
      part === "milliseconds" ? value : selectedDurationMillisecondsInput;

    if (part === "minutes") {
      setSelectedDurationMinutesInput(value);
    } else if (part === "seconds") {
      setSelectedDurationSecondsInput(value);
    } else {
      setSelectedDurationMillisecondsInput(value);
    }

    applySelectedDurationInputs(nextMinutes, nextSeconds, nextMilliseconds, false);
  }

  function commitSelectedDurationInput(): void {
    applySelectedDurationInputs(
      selectedDurationMinutesInput,
      selectedDurationSecondsInput,
      selectedDurationMillisecondsInput,
      true
    );
  }

  function handleSelectedScaleInputChange(value: string): void {
    setSelectedScaleInput(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    setSelectedTimelineTransform({ scale: parsed });
  }

  function commitSelectedScaleInput(): void {
    if (!selectedTimelineItem) {
      return;
    }

    const parsed = Number(selectedScaleInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const fallback = clampPieceScale(selectedTimelineItem.scale);
      setSelectedScaleInput(formatScaleLabel(fallback));
      return;
    }

    const clampedValue = clampPieceScale(parsed);
    setSelectedTimelineTransform({ scale: clampedValue });
    setSelectedScaleInput(formatScaleLabel(clampedValue));
  }

  function handleSelectedPanInputChange(axis: "x" | "y", value: string): void {
    if (axis === "x") {
      setSelectedPanXInput(value);
    } else {
      setSelectedPanYInput(value);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setSelectedTimelineTransform(axis === "x" ? { panX: parsed } : { panY: parsed });
  }

  function commitSelectedPanInput(axis: "x" | "y"): void {
    if (!selectedTimelineItem) {
      return;
    }

    const raw = axis === "x" ? selectedPanXInput : selectedPanYInput;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      if (axis === "x") {
        setSelectedPanXInput(normalizePanValue(selectedTimelineItem.panX).toString());
      } else {
        setSelectedPanYInput(normalizePanValue(selectedTimelineItem.panY).toString());
      }
      return;
    }

    const normalized = normalizePanValue(parsed);
    setSelectedTimelineTransform(axis === "x" ? { panX: normalized } : { panY: normalized });
    if (axis === "x") {
      setSelectedPanXInput(normalized.toString());
    } else {
      setSelectedPanYInput(normalized.toString());
    }
  }

  function resetSelectedTransform(): void {
    setSelectedTimelineTransform({ scale: 1, panX: 0, panY: 0 });
  }

  function fillSelectedPieceToCrop(): void {
    if (!selectedTimelineItem) {
      return;
    }
    const clip = clipById.get(selectedTimelineItem.sourceClipId);
    if (!clip || clip.width <= 0 || clip.height <= 0) {
      return;
    }

    const baseContainScale = Math.min(workspaceWidth / clip.width, workspaceHeight / clip.height);
    if (!Number.isFinite(baseContainScale) || baseContainScale <= 0) {
      return;
    }
    const baseWidth = clip.width * baseContainScale;
    const baseHeight = clip.height * baseContainScale;
    const targetRect = normalizedCropRect;
    const fillScale = Math.max(targetRect.width / baseWidth, targetRect.height / baseHeight);
    const cropCenterX = targetRect.x + targetRect.width / 2;
    const cropCenterY = targetRect.y + targetRect.height / 2;
    setSelectedTimelineTransform({
      scale: clampPieceScale(fillScale),
      panX: cropCenterX - workspaceWidth / 2,
      panY: cropCenterY - workspaceHeight / 2
    });
  }

  function applyCropRect(nextRect: CropRect): void {
    setCropRect(normalizeCropRect(nextRect, workspaceWidth, workspaceHeight));
  }

  function setCropField(
    field: "x" | "y" | "width" | "height",
    value: string
  ): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }

    const rounded = Math.round(parsed);
    const current = normalizedCropRect;
    let next: CropRect = { ...current, [field]: rounded };

    if (cropLockAspect && (field === "width" || field === "height")) {
      const ratio = cropAspectRatio > 0 ? cropAspectRatio : current.width / Math.max(1, current.height);
      if (field === "width") {
        next = {
          ...next,
          width: rounded,
          height: Math.max(MIN_CROP_SIZE_PX, Math.round(rounded / ratio))
        };
      } else {
        next = {
          ...next,
          height: rounded,
          width: Math.max(MIN_CROP_SIZE_PX, Math.round(rounded * ratio))
        };
      }
    }

    applyCropRect(next);
  }

  function resetCropRect(): void {
    applyCropRect({
      x: 0,
      y: 0,
      width: workspaceWidth,
      height: workspaceHeight
    });
  }

  function handleCropPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    mode: CropDragMode
  ): void {
    if (
      event.button !== 0 ||
      isBusy ||
      !cropEnabled ||
      clips.length === 0 ||
      workspaceWidth <= 0 ||
      workspaceHeight <= 0
    ) {
      return;
    }

    const surface = previewSurfaceRef.current;
    if (!surface) {
      return;
    }
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cropDragRef.current = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      overlayLeftPx: rect.left,
      overlayTopPx: rect.top,
      overlayWidthPx: rect.width,
      overlayHeightPx: rect.height,
      workspaceWidth,
      workspaceHeight,
      startRect: normalizedCropRect
    };
    setIsDraggingCrop(true);
  }

  function handlePreviewPanPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (
      event.button !== 0 ||
      isBusy ||
      !cropEnabled ||
      !selectedTimelineItem ||
      clips.length === 0 ||
      workspaceWidth <= 0 ||
      workspaceHeight <= 0
    ) {
      return;
    }

    const surface = previewSurfaceRef.current;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const selectedClip = clipById.get(selectedTimelineItem.sourceClipId);
    if (!selectedClip || selectedClip.width <= 0 || selectedClip.height <= 0) {
      return;
    }

    const containScale = Math.min(
      workspaceWidth / selectedClip.width,
      workspaceHeight / selectedClip.height
    );
    if (!Number.isFinite(containScale) || containScale <= 0) {
      return;
    }
    const drawWidth = selectedClip.width * containScale * clampPieceScale(selectedTimelineItem.scale);
    const drawHeight = selectedClip.height * containScale * clampPieceScale(selectedTimelineItem.scale);
    const baseX = (workspaceWidth - drawWidth) / 2;
    const baseY = (workspaceHeight - drawHeight) / 2;

    event.preventDefault();
    event.stopPropagation();
    previewPanDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      overlayWidthPx: rect.width,
      overlayHeightPx: rect.height,
      workspaceWidth,
      workspaceHeight,
      initialPanX: selectedTimelineItem.panX,
      initialPanY: selectedTimelineItem.panY,
      baseX,
      baseY,
      drawWidth,
      drawHeight,
      cropRect: normalizedCropRect
    };
    setIsDraggingPreviewPan(true);
  }

  function handleSplitterPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    splitter: Exclude<ActiveSplitter, null>
  ): void {
    if (event.button !== 0 || !isDesktopViewport) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    splitterDragRef.current = {
      splitter,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSizes: workspacePaneSizes
    };
    setActiveSplitter(splitter);
  }

  function resetSplitterSize(splitter: Exclude<ActiveSplitter, null>): void {
    setWorkspacePaneSizes((previous) =>
      clampPaneSizes({
        ...previous,
        [splitter]: DEFAULT_PANE_SIZES[splitter]
      })
    );
  }

  async function handleExport(): Promise<void> {
    if (editedSegments.length === 0 || isBusy) {
      return;
    }

    const includeVideo = effectiveIncludeVideo;
    const includeAudio = effectiveIncludeAudio;
    if (!includeVideo && !includeAudio) {
      setError("Enable video or audio before exporting.");
      return;
    }

    const widthValue = exportWidthInput.trim();
    const heightValue = exportHeightInput.trim();
    const fpsValue = exportFpsInput.trim();
    const videoBitrateValue = exportVideoBitrateInput.trim();
    const audioBitrateValue = exportAudioBitrateInput.trim();

    let exportFps: number | undefined;
    let exportVideoBitrateKbps: number | undefined;
    let exportAudioBitrateKbps: number | undefined;

    if (includeVideo) {
      if ((widthValue === "") !== (heightValue === "")) {
        setError("Set both workspace width and height, or leave both empty.");
        return;
      }

      if (widthValue !== "" && heightValue !== "") {
        const parsedWidth = parsePositiveIntegerInput(widthValue);
        const parsedHeight = parsePositiveIntegerInput(heightValue);
        if (!parsedWidth || !parsedHeight || parsedWidth < 2 || parsedHeight < 2) {
          setError("Workspace resolution must use positive integers.");
          return;
        }
      }

      if (fpsValue !== "") {
        const parsedFps = Number(fpsValue);
        if (!Number.isFinite(parsedFps) || parsedFps < 1 || parsedFps > 120) {
          setError("FPS must be between 1 and 120.");
          return;
        }
        exportFps = Math.round(parsedFps);
      }
    }

    if (includeVideo && videoBitrateValue !== "") {
      const parsedVideoBitrate = parsePositiveIntegerInput(videoBitrateValue);
      if (!parsedVideoBitrate || parsedVideoBitrate < 100 || parsedVideoBitrate > 200_000) {
        setError("Video bitrate must be between 100 and 200000 kbps.");
        return;
      }
      exportVideoBitrateKbps = parsedVideoBitrate;
    }

    if (includeAudio && audioBitrateValue !== "") {
      const parsedAudioBitrate = parsePositiveIntegerInput(audioBitrateValue);
      if (!parsedAudioBitrate || parsedAudioBitrate < 8 || parsedAudioBitrate > 3_200) {
        setError("Audio bitrate must be between 8 and 3200 kbps.");
        return;
      }
      exportAudioBitrateKbps = parsedAudioBitrate;
    }

    setIsExporting(true);
    setExportStage("loading-core");
    setExportStatusMessage("Loading FFmpeg core...");
    setExportProgress(0);
    setExportFrameProgress(null);
    setExportStartedAtMs(Date.now());
    setExportNowMs(Date.now());
    setError(null);

    try {
      const exportSegments = editedSegments.map((segment) => {
        const clip = clipById.get(segment.clipId);
        if (!clip) {
          throw new Error("A source clip referenced by the timeline could not be found.");
        }

        return {
          file: clip.file,
          startSec: segment.sourceStart,
          endSec: segment.sourceEnd,
          speed: segment.speed,
          scale: segment.scale,
          panX: segment.panX,
          panY: segment.panY,
          width: clip.width,
          height: clip.height
        };
      });

      const blob = await exportEditedTimeline(exportSegments, {
        mode: exportMode,
        format: exportFormat,
        workspaceWidth: includeVideo ? workspaceWidth : undefined,
        workspaceHeight: includeVideo ? workspaceHeight : undefined,
        fps: exportFps,
        crop: {
          enabled: cropEnabled,
          x: normalizedCropRect.x,
          y: normalizedCropRect.y,
          width: normalizedCropRect.width,
          height: normalizedCropRect.height
        },
        includeVideo,
        includeAudio,
        videoBitrateKbps: exportVideoBitrateKbps,
        audioBitrateKbps: exportAudioBitrateKbps,
        onStageChange: (stage, message) => {
          setExportStage(stage);
          setExportStatusMessage(message);
        },
        onProgress: (value) => setExportProgress(value),
        onFrameProgress: (currentFrame, totalFrames, percent) => {
          setExportFrameProgress({ currentFrame, totalFrames, percent });
        }
      });

      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `edited-video.${exportFormatConfig.extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
      }, 1000);

      setExportProgress(1);
      setExportStage("finalizing");
      setExportStatusMessage("Finalizing export...");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Export failed unexpectedly.";
      setError(message);
    } finally {
      setIsExporting(false);
      setExportStartedAtMs(null);
    }
  }

  const mediaBinContent = (
    <>
      <div className="panel-header">
        <p className="panel-title">Media Bin</p>
        <div className="panel-header-actions">
          <button
            className="button secondary tiny"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
          >
            {isIngesting ? "Loading..." : "Import"}
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={clearQueue}
            disabled={clips.length === 0 || isBusy}
          >
            Clear
          </button>
        </div>
      </div>

      <div
        className={`media-dropzone ${isDragging ? "dragging" : ""}`}
        onDrop={(event) => void handleDrop(event)}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <p className="dropzone-title">Drop videos here</p>
        <p className="dropzone-subtitle">Multiple files are concatenated by timeline order.</p>
      </div>

      <div className="media-metrics">
        <span className="metric-chip">Clips {clips.length}</span>
        <span className="metric-chip">Source {formatDuration(totalSourceDurationSec)}</span>
      </div>

      {clips.length === 0 ? (
        <p className="queue-empty">No clips yet.</p>
      ) : (
        <ul className="queue-list">
          {clips.map((clip, index) => (
            <li
              key={clip.id}
              className="queue-item"
            >
              <div className="queue-select">
                <span className="queue-order">{index + 1}</span>
                <span className="queue-name">{clip.file.name}</span>
                <span className="queue-size">
                  {formatDuration(clip.duration)} · {formatFileSize(clip.file.size)}
                </span>
              </div>
              <button
                className="button ghost tiny"
                type="button"
                onClick={() => removeClip(clip.id)}
                disabled={isBusy}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const previewStageContent = (
    <>
      <div className="preview-frame">
        {isPreviewSupported ? (
          <div
            ref={previewSurfaceRef}
            className="preview-surface"
          >
            <canvas
              ref={previewCanvasRef}
              className="preview-canvas"
            />
            {clips.length > 0 && cropEnabled && (
              <div
                className={`crop-overlay${isDraggingCrop ? " dragging" : ""}${
                  isDraggingPreviewPan ? " panning" : ""
                }${selectedTimelineItem ? " has-pan" : ""}`}
              >
                <div
                  className="crop-mask-pane crop-mask-pane-top"
                  style={{ top: "0%", left: "0%", width: "100%", height: `${cropRectPercent.top}%` }}
                  onPointerDown={handlePreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-left"
                  style={{
                    top: `${cropRectPercent.top}%`,
                    left: "0%",
                    width: `${cropRectPercent.left}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={handlePreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-right"
                  style={{
                    top: `${cropRectPercent.top}%`,
                    left: `${cropRectPercent.left + cropRectPercent.width}%`,
                    width: `${cropMaskPercent.right}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={handlePreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-bottom"
                  style={{
                    top: `${cropRectPercent.top + cropRectPercent.height}%`,
                    left: "0%",
                    width: "100%",
                    height: `${cropMaskPercent.bottom}%`
                  }}
                  onPointerDown={handlePreviewPanPointerDown}
                />
                <div
                  className="crop-window"
                  style={{
                    left: `${cropRectPercent.left}%`,
                    top: `${cropRectPercent.top}%`,
                    width: `${cropRectPercent.width}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={(event) => handleCropPointerDown(event, "move")}
                >
                  <span
                    className="crop-handle crop-handle-edge crop-handle-top"
                    onPointerDown={(event) => handleCropPointerDown(event, "top")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-right"
                    onPointerDown={(event) => handleCropPointerDown(event, "right")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-bottom"
                    onPointerDown={(event) => handleCropPointerDown(event, "bottom")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-left"
                    onPointerDown={(event) => handleCropPointerDown(event, "left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-top-left"
                    onPointerDown={(event) => handleCropPointerDown(event, "top-left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-top-right"
                    onPointerDown={(event) => handleCropPointerDown(event, "top-right")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-bottom-left"
                    onPointerDown={(event) => handleCropPointerDown(event, "bottom-left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-bottom-right"
                    onPointerDown={(event) => handleCropPointerDown(event, "bottom-right")}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="preview-empty">
            <p>This browser does not support WebCodecs preview.</p>
          </div>
        )}
        {isPreviewSupported && clips.length === 0 && (
          <div className="preview-empty">
            <p>Add videos to start editing.</p>
          </div>
        )}
      </div>

      <div className="preview-transport">
        <button
          className="button primary"
          type="button"
          onClick={() => void togglePlayPause()}
          disabled={previewTimelineSegments.length === 0}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <div className="preview-readout-block">
          <p className="timeline-readout">
            {formatDuration(previewPositionSec)} / {formatDuration(previewDurationSec)}
          </p>
          <p className="timeline-readout-sub">
            Frame {currentPreviewFrame.toLocaleString()} / {totalPreviewFrames.toLocaleString()}
            {isFrameReadoutEstimated ? " (auto fps)" : ""}
          </p>
        </div>
        <div className="timeline-tools">
          <button
            className={`button ghost tiny${timelineTool === "select" ? " active" : ""}`}
            type="button"
            onClick={() => setTimelineTool("select")}
            disabled={isBusy}
          >
            Pointer
          </button>
          <button
            className={`button ghost tiny${timelineTool === "razor" ? " active" : ""}`}
            type="button"
            onClick={() => setTimelineTool("razor")}
            disabled={isBusy}
          >
            Razor
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={removeSelectedTimelinePiece}
            disabled={isBusy || !selectedTimelineItemId}
          >
            Delete Piece
          </button>
        </div>
      </div>
    </>
  );

  const timelineDockContent = timelineDurationSec <= 0 ? (
    <p className="queue-empty">Load clips to edit the timeline.</p>
  ) : (
    <div className="timeline-visual">
      <div
        className="timeline-track-shell"
        ref={trimRangeShellRef}
      >
        <div
          className="timeline-mask timeline-mask-start"
          style={{ width: `${trimStartPercent}%` }}
        />
        <div
          className="timeline-mask timeline-mask-end"
          style={{ width: `${trimRightPercent}%` }}
        />

        <div className={`timeline-track${timelineTool === "razor" ? " razor" : ""}`}>
          {timelineDisplayItems.map((item) => {
            const width = timelineDurationSec > 0 ? (item.duration / timelineDurationSec) * 100 : 0;
            const clip = clipById.get(item.sourceClipId);
            const clipFileName = clip?.file.name ?? "Unknown file";
            const isSelected = item.id === selectedTimelineItemId;
            const isDraggingItem = item.id === draggingTimelineItemId;

            return (
              <button
                key={item.id}
                className={`timeline-segment${isSelected ? " selected" : ""}${
                  isDraggingItem ? " dragging" : ""
                }`}
                style={{ width: `${width}%` }}
                type="button"
                onClick={(event) => handleTimelineSegmentClick(event, item)}
                onDragStart={(event) => handleTimelineItemDragStart(event, item.id)}
                onDragOver={handleTimelineItemDragOver}
                onDrop={(event) => handleTimelineItemDrop(event, item.id)}
                onDragEnd={handleTimelineItemDragEnd}
                draggable={!isBusy}
                disabled={isBusy}
                title={`File: ${clipFileName} · ${formatSecondsLabel(
                  item.sourceStart
                )} -> ${formatSecondsLabel(item.sourceEnd)} · ${formatSpeedLabel(item.speed)}x`}
              >
                <span className="timeline-segment-label">{clipFileName}</span>
              </button>
            );
          })}
        </div>

        <div
          className={`timeline-playhead${isDraggingPlayhead ? " dragging" : ""}`}
          style={{ left: `${playheadPercent}%` }}
          onPointerDown={handlePlayheadPointerDown}
          title="Drag playhead"
        />

        <div
          className={`trim-range-window${isDraggingTrimEdge ? " dragging" : ""}${
            activeTrimEdge === "start"
              ? " dragging-start"
              : activeTrimEdge === "end"
                ? " dragging-end"
                : ""
          }`}
          style={{
            left: `${trimStartPercent}%`,
            right: `${trimRightPercent}%`
          }}
        >
          <span
            className="trim-window-edge trim-window-edge-start"
            onPointerDown={(event) => handleTrimEdgePointerDown(event, "start")}
            title="Drag trim start edge"
          />
          <span
            className="trim-window-edge trim-window-edge-end"
            onPointerDown={(event) => handleTrimEdgePointerDown(event, "end")}
            title="Drag trim end edge"
          />
        </div>
      </div>

      <div className="trim-rail-values">
        <span>In {formatSecondsLabel(trimStartSec)}</span>
        <span>Out {formatSecondsLabel(trimEndSec)}</span>
      </div>
      <p className="hint">
        Click pieces to seek. Use Razor to split. Drag pieces left/right to reorder.
      </p>
    </div>
  );

  const exportDockContent = (
    <>
      <div className="export-settings">
        <p className="export-settings-title">Export Settings</p>
        <div className="export-settings-grid">
          <label>
            Format
            <select
              className="time-input export-format-select"
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
              disabled={isBusy}
            >
              {EXPORT_FORMAT_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            FPS
            <input
              className="time-input"
              type="number"
              min={1}
              max={120}
              step={1}
              placeholder="Auto"
              value={exportFpsInput}
              onChange={(event) => setExportFpsInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>

          <label>
            Workspace Width
            <input
              className="time-input"
              type="number"
              min={2}
              step={1}
              placeholder="Auto"
              value={exportWidthInput}
              onChange={(event) => setExportWidthInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>

          <label>
            Workspace Height
            <input
              className="time-input"
              type="number"
              min={2}
              step={1}
              placeholder="Auto"
              value={exportHeightInput}
              onChange={(event) => setExportHeightInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>
        </div>

        <div className="export-settings-actions">
          <button
            className="button ghost tiny"
            type="button"
            onClick={() => {
              if (largestClipResolution.area <= 0) {
                return;
              }
              setExportWidthInput(String(largestClipResolution.width));
              setExportHeightInput(String(largestClipResolution.height));
            }}
            disabled={isBusy || largestClipResolution.area <= 0 || !exportSupportsVideo}
          >
            Use Largest Source
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={() => {
              setExportWidthInput("");
              setExportHeightInput("");
            }}
            disabled={isBusy || !exportSupportsVideo}
          >
            Auto Workspace
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={() =>
              setInspectorOpenState((previous) => ({
                ...previous,
                advancedExport: !previous.advancedExport
              }))
            }
            disabled={isBusy}
          >
            {inspectorOpenState.advancedExport ? "Hide Advanced" : "Show Advanced"}
          </button>
        </div>

        {inspectorOpenState.advancedExport && (
          <div className="export-advanced">
            <p className="export-settings-subtitle">Advanced</p>
            <div className="toggle-row">
              <label className={`toggle-item${disableVideoToggle ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={effectiveIncludeVideo}
                  onChange={(event) => {
                    const nextValue = event.target.checked;
                    if (!nextValue && !effectiveIncludeAudio) {
                      return;
                    }
                    setIncludeVideoInExport(nextValue);
                  }}
                  disabled={disableVideoToggle}
                />
                Include Video
              </label>
              <label className={`toggle-item${disableAudioToggle ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={effectiveIncludeAudio}
                  onChange={(event) => {
                    const nextValue = event.target.checked;
                    if (!nextValue && !effectiveIncludeVideo) {
                      return;
                    }
                    setIncludeAudioInExport(nextValue);
                  }}
                  disabled={disableAudioToggle}
                />
                Include Audio
              </label>
            </div>
            <div className="export-settings-grid export-advanced-grid">
              <label>
                Video Bitrate (kbps)
                <input
                  className="time-input"
                  type="number"
                  min={100}
                  max={200000}
                  step={1}
                  placeholder="Auto"
                  value={exportVideoBitrateInput}
                  onChange={(event) => setExportVideoBitrateInput(event.target.value)}
                  disabled={isBusy || !effectiveIncludeVideo}
                />
              </label>
              <label>
                Audio Bitrate (kbps)
                <input
                  className="time-input"
                  type="number"
                  min={8}
                  max={3200}
                  step={1}
                  placeholder="Auto"
                  value={exportAudioBitrateInput}
                  onChange={(event) => setExportAudioBitrateInput(event.target.value)}
                  disabled={isBusy || !effectiveIncludeAudio}
                />
              </label>
            </div>
            <p className="hint">Leave bitrate empty to use codec defaults.</p>
          </div>
        )}

        <p className="hint">
          Workspace auto uses the largest source clip ({autoResolutionLabel}). FPS auto keeps source timing.
        </p>
        {exportSupportsVideo && (
          <p className="hint">
            Crop coordinates use workspace pixels. Enabled crop outputs {normalizedCropRect.width} x{" "}
            {normalizedCropRect.height}.
          </p>
        )}
        {!exportSupportsVideo && (
          <p className="hint">
            This format is audio-only. Workspace, crop, and FPS settings are ignored.
          </p>
        )}
        {!exportSupportsAudio && <p className="hint">This format does not support audio.</p>}
      </div>

      <div className="export-row">
        <div className="export-mode">
          <button
            className={`button ghost tiny${exportMode === "fit" ? " active" : ""}`}
            type="button"
            onClick={() => setExportMode("fit")}
            disabled={isBusy || !exportSupportsVideo}
          >
            Fit Canvas
          </button>
          <button
            className={`button ghost tiny${exportMode === "fast" ? " active" : ""}`}
            type="button"
            onClick={() => setExportMode("fast")}
            disabled={isBusy || !exportSupportsVideo}
          >
            Fast Copy
          </button>
        </div>

        <button
          className="button primary"
          type="button"
          onClick={() => void handleExport()}
          disabled={isBusy || editedSegments.length === 0}
        >
          {isExporting ? "Exporting..." : "Export Edited Video"}
        </button>
      </div>

      <p className="hint">
        {!exportSupportsVideo
          ? "Audio-only formats ignore workspace and crop settings."
          : exportMode === "fit"
            ? "Fit Canvas keeps a consistent workspace frame."
            : "Fast Copy is only available when no workspace, crop, transform, FPS, or speed changes are applied."}
      </p>

      {(isExporting || exportStage) && (
        <div className="progress-block">
          <p className="progress-label">
            {exportStatusMessage ?? (exportStage ? exportStageLabel(exportStage) : "Working...")}
          </p>
          <div className="progress-bar">
            <span
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, exportProgress)) * 100)}%`
              }}
            />
          </div>
          <p className="progress-meta">
            {exportProgressPercentText}
            {exportFrameCountText ? ` · ${exportFrameCountText}` : ""}
            {exportEtaText ? ` · ${exportEtaText}` : ""}
          </p>
        </div>
      )}
    </>
  );

  const previewDockContent = (
    <section className="preview-dock-panel">
      <div className="dock-tabs">
        <button
          className={`dock-tab${dockTab === "timeline" ? " active" : ""}`}
          type="button"
          onClick={() => setDockTab("timeline")}
        >
          Timeline
        </button>
        <button
          className={`dock-tab${dockTab === "export" ? " active" : ""}`}
          type="button"
          onClick={() => setDockTab("export")}
        >
          Export
        </button>
      </div>
      <div className="dock-content">{dockTab === "timeline" ? timelineDockContent : exportDockContent}</div>
    </section>
  );

  const cropPanelContent = (
    <section className="inspector-section">
      <button
        className="inspector-section-toggle"
        type="button"
        onClick={() =>
          setInspectorOpenState((previous) => ({
            ...previous,
            crop: !previous.crop
          }))
        }
      >
        <span>Crop (Global)</span>
        <span>{inspectorOpenState.crop ? "Hide" : "Show"}</span>
      </button>
      {inspectorOpenState.crop && (
        <div className="inspector-section-body">
          <div className="crop-controls">
            <div className="crop-controls-row">
              <label className={`toggle-item${clips.length === 0 ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={cropEnabled}
                  onChange={(event) => setCropEnabled(event.target.checked)}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
                Enable Crop
              </label>
              <button
                className="button ghost tiny"
                type="button"
                onClick={resetCropRect}
                disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
              >
                Reset Crop
              </button>
            </div>
            <div className="crop-controls-row">
              <label className={`toggle-item${clips.length === 0 ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={cropLockAspect}
                  onChange={(event) => {
                    const nextChecked = event.target.checked;
                    if (nextChecked && normalizedCropRect.height > 0) {
                      setCropAspectRatio(normalizedCropRect.width / normalizedCropRect.height);
                    }
                    setCropLockAspect(nextChecked);
                  }}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
                Lock Aspect Ratio
              </label>
            </div>
            <div className="crop-input-grid">
              <label>
                X
                <input
                  className="time-input"
                  type="number"
                  step={1}
                  min={0}
                  value={normalizedCropRect.x}
                  onChange={(event) => setCropField("x", event.target.value)}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
              </label>
              <label>
                Y
                <input
                  className="time-input"
                  type="number"
                  step={1}
                  min={0}
                  value={normalizedCropRect.y}
                  onChange={(event) => setCropField("y", event.target.value)}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
              </label>
              <label>
                W
                <input
                  className="time-input"
                  type="number"
                  step={1}
                  min={MIN_CROP_SIZE_PX}
                  value={normalizedCropRect.width}
                  onChange={(event) => setCropField("width", event.target.value)}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
              </label>
              <label>
                H
                <input
                  className="time-input"
                  type="number"
                  step={1}
                  min={MIN_CROP_SIZE_PX}
                  value={normalizedCropRect.height}
                  onChange={(event) => setCropField("height", event.target.value)}
                  disabled={isBusy || clips.length === 0 || !exportSupportsVideo}
                />
              </label>
            </div>
            <p className="hint">
              Drag the shaded mask around the preview to pan selected content. Hold Shift to bypass snapping.
            </p>
          </div>
        </div>
      )}
    </section>
  );

  const inspectorContent = (
    <div className="inspector-stack">
      {selectedTimelineItem ? (
        <section className="inspector-section">
          <button
            className="inspector-section-toggle"
            type="button"
            onClick={() =>
              setInspectorOpenState((previous) => ({
                ...previous,
                segment: !previous.segment
              }))
            }
          >
            <span>Selected Segment</span>
            <span>{inspectorOpenState.segment ? "Hide" : "Show"}</span>
          </button>

          {inspectorOpenState.segment && (
            <div className="inspector-section-body">
              <p className="hint">
                {clipById.get(selectedTimelineItem.sourceClipId)?.file.name ?? "Unknown"} ·{" "}
                {formatSecondsLabel(selectedTimelineItem.sourceStart)} -{" "}
                {formatSecondsLabel(selectedTimelineItem.sourceEnd)}
              </p>

              <div className="inspector-subsection">
                <button
                  className="inspector-subsection-toggle"
                  type="button"
                  onClick={() =>
                    setInspectorOpenState((previous) => ({
                      ...previous,
                      speed: !previous.speed
                    }))
                  }
                >
                  <span>Speed + Duration</span>
                  <span>{inspectorOpenState.speed ? "Hide" : "Show"}</span>
                </button>

                {inspectorOpenState.speed && (
                  <div className="inspector-subsection-body">
                    <div className="piece-speed-header">
                      <span>Speed</span>
                      <strong>{formatSpeedLabel(selectedTimelineItem.speed)}x</strong>
                    </div>
                    <label className="piece-speed-input-row">
                      <span>Precise value</span>
                      <div className="piece-speed-input-wrap">
                        <input
                          className="time-input piece-speed-input"
                          type="number"
                          min={MIN_SEGMENT_SPEED}
                          max={MAX_SEGMENT_SPEED}
                          step="any"
                          value={selectedSpeedInput}
                          onChange={(event) => handleSelectedSpeedInputChange(event.target.value)}
                          onBlur={commitSelectedSpeedInput}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedSpeedInput();
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece speed input"
                        />
                        <span>x</span>
                      </div>
                    </label>
                    <input
                      className="piece-speed-slider"
                      type="range"
                      min={MIN_SEGMENT_SPEED_LOG}
                      max={MAX_SEGMENT_SPEED_LOG}
                      step={0.01}
                      value={selectedSpeedSliderValue}
                      onChange={(event) =>
                        setSelectedTimelineSpeed(logSliderValueToSpeed(Number(event.target.value)))
                      }
                      disabled={isBusy}
                      aria-label="Selected piece speed"
                    />
                    <div className="piece-speed-scale">
                      <span>{formatSpeedLabel(MIN_SEGMENT_SPEED)}x</span>
                      <span>1x</span>
                      <span>{formatSpeedLabel(MAX_SEGMENT_SPEED)}x</span>
                    </div>
                    <div className="duration-input-grid">
                      <label>
                        Min
                        <input
                          className="time-input"
                          type="number"
                          min={0}
                          step={1}
                          value={selectedDurationMinutesInput}
                          onChange={(event) =>
                            handleSelectedDurationInputChange("minutes", event.target.value)
                          }
                          onBlur={commitSelectedDurationInput}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedDurationInput();
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece duration minutes"
                        />
                      </label>
                      <label>
                        Sec
                        <input
                          className="time-input"
                          type="number"
                          min={0}
                          step={1}
                          value={selectedDurationSecondsInput}
                          onChange={(event) =>
                            handleSelectedDurationInputChange("seconds", event.target.value)
                          }
                          onBlur={commitSelectedDurationInput}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedDurationInput();
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece duration seconds"
                        />
                      </label>
                      <label>
                        Ms
                        <input
                          className="time-input"
                          type="number"
                          min={0}
                          step={1}
                          value={selectedDurationMillisecondsInput}
                          onChange={(event) =>
                            handleSelectedDurationInputChange("milliseconds", event.target.value)
                          }
                          onBlur={commitSelectedDurationInput}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedDurationInput();
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece duration milliseconds"
                        />
                      </label>
                    </div>
                    <div className="piece-speed-presets">
                      {[0.01, 0.1, 0.5, 1, 2, 10, 100].map((preset) => (
                        <button
                          key={preset}
                          className={`button ghost tiny${
                            Math.abs(selectedTimelineItem.speed - preset) <=
                            Math.max(0.00001, preset * 0.01)
                              ? " active"
                              : ""
                          }`}
                          type="button"
                          onClick={() => setSelectedTimelineSpeed(preset)}
                          disabled={isBusy}
                        >
                          {formatSpeedLabel(preset)}x
                        </button>
                      ))}
                    </div>
                    <div className="trim-rail-values">
                      <span>
                        Source{" "}
                        {formatSecondsLabel(
                          Math.max(0, selectedTimelineItem.sourceEnd - selectedTimelineItem.sourceStart)
                        )}
                      </span>
                      <span>Timeline {formatSecondsLabel(selectedTimelineItem.duration)}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="inspector-subsection">
                <button
                  className="inspector-subsection-toggle"
                  type="button"
                  onClick={() =>
                    setInspectorOpenState((previous) => ({
                      ...previous,
                      transform: !previous.transform
                    }))
                  }
                >
                  <span>Transform</span>
                  <span>{inspectorOpenState.transform ? "Hide" : "Show"}</span>
                </button>

                {inspectorOpenState.transform && (
                  <div className="inspector-subsection-body">
                    <div className="piece-speed-header">
                      <span>Scale</span>
                      <strong>{formatScaleLabel(selectedTimelineItem.scale)}x</strong>
                    </div>
                    <label className="piece-speed-input-row">
                      <span>Scale</span>
                      <div className="piece-speed-input-wrap">
                        <input
                          className="time-input piece-speed-input"
                          type="number"
                          min={MIN_PIECE_SCALE}
                          max={MAX_PIECE_SCALE}
                          step="any"
                          value={selectedScaleInput}
                          onChange={(event) => handleSelectedScaleInputChange(event.target.value)}
                          onBlur={commitSelectedScaleInput}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedScaleInput();
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece scale input"
                        />
                        <span>x</span>
                      </div>
                    </label>
                    <input
                      className="piece-speed-slider"
                      type="range"
                      min={MIN_PIECE_SCALE_LOG}
                      max={MAX_PIECE_SCALE_LOG}
                      step={0.01}
                      value={selectedScaleSliderValue}
                      onChange={(event) =>
                        setSelectedTimelineTransform({
                          scale: logSliderValueToScale(Number(event.target.value))
                        })
                      }
                      disabled={isBusy}
                      aria-label="Selected piece scale"
                    />
                    <div className="piece-speed-scale">
                      <span>{formatScaleLabel(MIN_PIECE_SCALE)}x</span>
                      <span>1x</span>
                      <span>{formatScaleLabel(MAX_PIECE_SCALE)}x</span>
                    </div>
                    <label className="piece-speed-input-row">
                      <span>Pan X</span>
                      <div className="piece-speed-input-wrap">
                        <input
                          className="time-input piece-speed-input"
                          type="number"
                          step="any"
                          value={selectedPanXInput}
                          onChange={(event) => handleSelectedPanInputChange("x", event.target.value)}
                          onBlur={() => commitSelectedPanInput("x")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedPanInput("x");
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece pan X input"
                        />
                        <span>px</span>
                      </div>
                    </label>
                    <label className="piece-speed-input-row">
                      <span>Pan Y</span>
                      <div className="piece-speed-input-wrap">
                        <input
                          className="time-input piece-speed-input"
                          type="number"
                          step="any"
                          value={selectedPanYInput}
                          onChange={(event) => handleSelectedPanInputChange("y", event.target.value)}
                          onBlur={() => commitSelectedPanInput("y")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitSelectedPanInput("y");
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={isBusy}
                          aria-label="Selected piece pan Y input"
                        />
                        <span>px</span>
                      </div>
                    </label>
                    <div className="piece-speed-presets">
                      <button
                        className="button ghost tiny"
                        type="button"
                        onClick={fillSelectedPieceToCrop}
                        disabled={isBusy}
                      >
                        Fill Crop
                      </button>
                      <button
                        className="button ghost tiny"
                        type="button"
                        onClick={resetSelectedTransform}
                        disabled={isBusy}
                      >
                        Reset Transform
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      ) : (
        <p className="queue-empty">Select a timeline piece to edit speed and transform.</p>
      )}
    </div>
  );

  return (
    <main className="app-shell">
      {error && <p className="status error">{error}</p>}

      <section className="workspace-panel top-media-panel">
        {mediaBinContent}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          onChange={(event) => void handleFileInput(event)}
          hidden
        />
      </section>

      <div
        className={`workspace-shell${isDesktopViewport ? " desktop" : " stacked"}`}
        style={workstationStyle}
      >
        {isDesktopViewport ? (
          <>
            <aside className={`workspace-panel left-tools-panel${isLeftPanelCollapsed ? " collapsed" : ""}`}>
              {isLeftPanelCollapsed ? (
                <button
                  className="panel-edge-tab panel-edge-tab-left"
                  type="button"
                  onClick={() => setIsLeftPanelCollapsed(false)}
                  aria-label="Open crop panel"
                >
                  Crop
                </button>
              ) : (
                <>
                  <div className="side-panel-header">
                    <button
                      className="button ghost tiny panel-collapse-trigger"
                      type="button"
                      onClick={() => setIsLeftPanelCollapsed(true)}
                    >
                      Hide Panel
                    </button>
                  </div>
                  {cropPanelContent}
                </>
              )}
            </aside>
            {!isLeftPanelCollapsed && (
              <div
                className={`workspace-splitter vertical splitter-left${
                  activeSplitter === "left" ? " active" : ""
                }`}
                onPointerDown={(event) => handleSplitterPointerDown(event, "left")}
                onDoubleClick={() => resetSplitterSize("left")}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize crop panel"
              />
            )}

            <section className="workspace-panel preview-stage-panel">
              {previewStageContent}
              {previewDockContent}
            </section>
            {!isRightPanelCollapsed && (
              <div
                className={`workspace-splitter vertical splitter-right${
                  activeSplitter === "right" ? " active" : ""
                }`}
                onPointerDown={(event) => handleSplitterPointerDown(event, "right")}
                onDoubleClick={() => resetSplitterSize("right")}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize inspector panel"
              />
            )}

            <aside className={`workspace-panel inspector-panel${isRightPanelCollapsed ? " collapsed" : ""}`}>
              {isRightPanelCollapsed ? (
                <button
                  className="panel-edge-tab panel-edge-tab-right"
                  type="button"
                  onClick={() => setIsRightPanelCollapsed(false)}
                  aria-label="Open inspector panel"
                >
                  Inspector
                </button>
              ) : (
                <>
                  <div className="side-panel-header side-panel-header-right">
                    <button
                      className="button ghost tiny panel-collapse-trigger"
                      type="button"
                      onClick={() => setIsRightPanelCollapsed(true)}
                    >
                      Hide Panel
                    </button>
                  </div>
                  {inspectorContent}
                </>
              )}
            </aside>
          </>
        ) : (
          <>
            <section className="workspace-panel preview-stage-panel">
              {previewStageContent}
              {previewDockContent}
            </section>
            <div className="utility-tabs">
              <button
                className={`dock-tab${utilityTab === "inspector" ? " active" : ""}`}
                type="button"
                onClick={() => setUtilityTab("inspector")}
              >
                Inspector
              </button>
              <button
                className={`dock-tab${utilityTab === "crop" ? " active" : ""}`}
                type="button"
                onClick={() => setUtilityTab("crop")}
              >
                Crop
              </button>
            </div>
            <section className="workspace-panel stacked-utility-panel">
              {utilityTab === "crop" && cropPanelContent}
              {utilityTab === "inspector" && inspectorContent}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export default App;
