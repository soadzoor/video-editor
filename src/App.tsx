import {
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
  timelineStart: number;
  timelineEnd: number;
  editedStart: number;
  editedEnd: number;
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

function normalizeTimeValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1_000_000) / 1_000_000;
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

function App() {
  const [clips, setClips] = useState<SourceClip[]>([]);
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  const [isDragging, setIsDragging] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [trimStartSec, setTrimStartSec] = useState(0);
  const [trimEndSec, setTrimEndSec] = useState(0);
  const [editedPositionSec, setEditedPositionSec] = useState(0);
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
  const [isExportAdvancedOpen, setIsExportAdvancedOpen] = useState(false);
  const [includeVideoInExport, setIncludeVideoInExport] = useState(true);
  const [includeAudioInExport, setIncludeAudioInExport] = useState(true);
  const [exportVideoBitrateInput, setExportVideoBitrateInput] = useState("");
  const [exportAudioBitrateInput, setExportAudioBitrateInput] = useState("");

  const [isDraggingTrimEdge, setIsDraggingTrimEdge] = useState(false);
  const [activeTrimEdge, setActiveTrimEdge] = useState<"start" | "end" | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [selectedSpeedInput, setSelectedSpeedInput] = useState("");
  const [isPreviewSupported] = useState(
    () => typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewEngineRef = useRef<TimelinePreviewEngine | null>(null);
  const editedSegmentsRef = useRef<EditedSegment[]>([]);
  const clipsRef = useRef<SourceClip[]>([]);

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

  const editedDurationSec =
    editedSegments.length > 0 ? editedSegments[editedSegments.length - 1].editedEnd : 0;
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
  const totalEditedFrames = Math.max(0, Math.round(editedDurationSec * frameReadoutFps));
  const currentEditedFrame =
    totalEditedFrames > 0
      ? clamp(Math.floor(editedPositionSec * frameReadoutFps), 0, totalEditedFrames)
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

  const playheadRawSec = useMemo(() => {
    if (timelineDurationSec <= 0) {
      return 0;
    }

    if (editedSegments.length === 0) {
      return clamp(trimStartSec, 0, timelineDurationSec);
    }

    if (editedPositionSec <= 0) {
      return clamp(trimStartSec, 0, timelineDurationSec);
    }

    if (editedPositionSec >= editedDurationSec) {
      return clamp(trimEndSec, 0, timelineDurationSec);
    }

    const segmentIndex = findSegmentIndex(editedSegments, editedPositionSec);
    if (segmentIndex < 0) {
      return clamp(trimStartSec, 0, timelineDurationSec);
    }

    const segment = editedSegments[segmentIndex];
    return clamp(
      segment.timelineStart + (editedPositionSec - segment.editedStart),
      0,
      timelineDurationSec
    );
  }, [
    editedDurationSec,
    editedPositionSec,
    editedSegments,
    timelineDurationSec,
    trimEndSec,
    trimStartSec
  ]);

  const playheadPercent =
    timelineDurationSec > 0 ? (clamp(playheadRawSec, 0, timelineDurationSec) / timelineDurationSec) * 100 : 0;

  const selectedTimelineItem = selectedTimelineItemId
    ? timelineDisplayItems.find((item) => item.id === selectedTimelineItemId) ?? null
    : null;
  const selectedSpeedSliderValue = selectedTimelineItem
    ? speedToLogSliderValue(selectedTimelineItem.speed)
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
      editedSegments.map((segment) => ({
        id: segment.id,
        clipId: segment.clipId,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        speed: segment.speed,
        editedStart: segment.editedStart,
        editedEnd: segment.editedEnd
      })),
    [editedSegments]
  );

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    return () => {
      for (const clip of clipsRef.current) {
        URL.revokeObjectURL(clip.url);
      }
    };
  }, []);

  useEffect(() => {
    editedSegmentsRef.current = editedSegments;
  }, [editedSegments]);

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
        setEditedPositionSec((previous) => (nearlyEqual(previous, timeSec) ? previous : timeSec));

        const currentSegments = editedSegmentsRef.current;
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
    void engine.setProject(previewClips, previewSegments, currentPosition);
  }, [isPreviewSupported, previewClips, previewSegments]);

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
      setSelectedSpeedInput("");
      return;
    }
    setSelectedSpeedInput(formatSpeedLabel(selectedTimelineItem.speed));
  }, [selectedTimelineItemId, selectedTimelineItem?.speed]);

  // Reposition playback when timeline structure changes.
  useEffect(() => {
    if (editedSegments.length === 0) {
      previewEngineRef.current?.pause();
      setCurrentSegmentIndex(0);
      setEditedPositionSec(0);
      setIsPlaying(false);
      return;
    }

    const engine = previewEngineRef.current;
    const upperBound = Math.max(0, editedDurationSec - 0.0001);
    const currentPosition = engine?.getPositionSec() ?? editedPositionSec;
    const clampedPosition = clamp(currentPosition, 0, upperBound);
    const nextSegmentIndex = Math.max(0, findSegmentIndex(editedSegments, clampedPosition));
    engine?.pause();
    setIsPlaying(false);
    setEditedPositionSec((previous) => (nearlyEqual(previous, clampedPosition) ? previous : clampedPosition));
    setCurrentSegmentIndex((previous) => (previous === nextSegmentIndex ? previous : nextSegmentIndex));
    engine?.seek(clampedPosition);
  }, [editedDurationSec, editedSegments]);

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
        applyTrimStart(drag.initialStartSec + deltaSec);
      } else {
        applyTrimEnd(drag.initialEndSec + deltaSec);
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
  }, [isDraggingTrimEdge, timelineDurationSec]);

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
      seekToTimelinePosition(rawPosition, false);
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

  function resetTimelineWindow(durationSec: number): void {
    skipTrimRescaleRef.current = true;
    previewEngineRef.current?.pause();
    previewEngineRef.current?.seek(0);
    setTrimStartSec(0);
    setTrimEndSec(durationSec);
    setEditedPositionSec(0);
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
        speed: 1
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
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function seekToEditedPosition(targetSec: number, autoPlay: boolean): void {
    if (editedSegments.length === 0) {
      return;
    }

    const upperBound = Math.max(0, editedDurationSec - 0.0001);
    const clamped = clamp(targetSec, 0, upperBound);
    const nextIndex = findSegmentIndex(editedSegments, clamped);
    if (nextIndex < 0) {
      return;
    }

    setEditedPositionSec(clamped);
    setCurrentSegmentIndex(nextIndex);

    const engine = previewEngineRef.current;
    if (!engine) {
      return;
    }

    engine.seek(clamped);
    if (autoPlay) {
      void engine.play().catch(() => {
        setError("Unable to start playback. Interact with the page and try again.");
      });
      return;
    }

    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    }
  }

  function seekToTimelinePosition(rawPositionSec: number, autoPlay: boolean): void {
    if (editedSegments.length === 0) {
      return;
    }

    const boundedRaw = clamp(rawPositionSec, trimStartSec, trimEndSec);
    const targetEdited = clamp(boundedRaw - trimStartSec, 0, editedDurationSec);
    seekToEditedPosition(targetEdited, autoPlay);
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
    if (!engine || editedSegments.length === 0) {
      return;
    }

    if (!isPlaying) {
      if (editedPositionSec >= editedDurationSec - SEGMENT_END_EPSILON) {
        seekToEditedPosition(0, false);
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
        speed: target.speed
      };
      const rightPiece: TimelineItem = {
        id: rightId,
        sourceClipId: target.sourceClipId,
        sourceStart: splitSource,
        sourceEnd: target.sourceEnd,
        speed: target.speed
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
    if (event.button !== 0 || isBusy || timelineDurationSec <= 0 || editedSegments.length === 0) {
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
    seekToTimelinePosition(rawPosition, false);
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

    let exportWidth: number | undefined;
    let exportHeight: number | undefined;
    let exportFps: number | undefined;
    let exportVideoBitrateKbps: number | undefined;
    let exportAudioBitrateKbps: number | undefined;

    if (includeVideo) {
      if ((widthValue === "") !== (heightValue === "")) {
        setError("Set both output width and height, or leave both empty.");
        return;
      }

      if (widthValue !== "" && heightValue !== "") {
        const parsedWidth = parsePositiveIntegerInput(widthValue);
        const parsedHeight = parsePositiveIntegerInput(heightValue);
        if (!parsedWidth || !parsedHeight || parsedWidth < 2 || parsedHeight < 2) {
          setError("Output resolution must use positive integers.");
          return;
        }
        exportWidth = parsedWidth;
        exportHeight = parsedHeight;
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
          width: clip.width,
          height: clip.height
        };
      });

      const blob = await exportEditedTimeline(exportSegments, {
        mode: exportMode,
        format: exportFormat,
        outputWidth: exportWidth,
        outputHeight: exportHeight,
        fps: exportFps,
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

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Timeline Editor</p>
        <h1>Browser Video Editor</h1>
        <p className="hero-copy">
          Add one or more videos, edit on a single timeline, then export once.
        </p>
      </header>

      <section
        className={`dropzone ${isDragging ? "dragging" : ""}`}
        onDrop={(event) => void handleDrop(event)}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="dropzone-content">
          <p className="dropzone-title">Drag and drop videos</p>
          <p className="dropzone-subtitle">
            Multiple videos are concatenated by default in timeline order.
          </p>
          <button
            className="button secondary"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
          >
            {isIngesting ? "Loading..." : "Browse Files"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            onChange={(event) => void handleFileInput(event)}
            hidden
          />
        </div>
      </section>

      {error && <p className="status error">{error}</p>}

      <section className="queue-panel">
        <div className="queue-header">
          <p className="queue-title">Source Queue ({clips.length})</p>
          <button
            className="button ghost"
            type="button"
            onClick={clearQueue}
            disabled={clips.length === 0 || isBusy}
          >
            Clear Queue
          </button>
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
      </section>

      <section className="preview-panel">
        <div className="preview-frame">
          {isPreviewSupported ? (
            <canvas
              ref={previewCanvasRef}
              className="preview-canvas"
            />
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
      </section>

      <section className="edit-panel">
        <p className="queue-title">Timeline Controls</p>

        {timelineDurationSec <= 0 ? (
          <p className="queue-empty">Load clips to edit the timeline.</p>
        ) : (
          <>
            <div className="timeline-toolbar">
              <button
                className="button primary"
                type="button"
                onClick={() => void togglePlayPause()}
                disabled={editedSegments.length === 0}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>

              <p className="timeline-readout">
                {formatDuration(editedPositionSec)} / {formatDuration(editedDurationSec)}
              </p>
              <p className="timeline-readout-sub">
                Frame {currentEditedFrame.toLocaleString()} / {totalEditedFrames.toLocaleString()}
                {isFrameReadoutEstimated ? " (auto fps)" : ""}
              </p>

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
                    const width =
                      timelineDurationSec > 0 ? (item.duration / timelineDurationSec) * 100 : 0;
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

              {selectedTimelineItem ? (
                <div className="piece-speed-panel">
                  <p className="hint">
                    Selected piece: {clipById.get(selectedTimelineItem.sourceClipId)?.file.name ?? "Unknown"} ·{" "}
                    {formatSecondsLabel(selectedTimelineItem.sourceStart)} - {formatSecondsLabel(selectedTimelineItem.sourceEnd)}
                  </p>
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
                  <p className="hint">Log slider: 1x is centered.</p>
                  <p className="hint">Preview uses a custom WebCodecs + Canvas engine.</p>
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
              ) : (
                <p className="hint">
                  Click pieces to seek. Use Razor to split. Drag pieces left/right to reorder.
                </p>
              )}
            </div>

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
                  Width
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
                  Height
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
                  Auto Resolution
                </button>
                <button
                  className="button ghost tiny"
                  type="button"
                  onClick={() => setIsExportAdvancedOpen((previous) => !previous)}
                  disabled={isBusy}
                >
                  {isExportAdvancedOpen ? "Hide Advanced" : "Show Advanced"}
                </button>
              </div>

              {isExportAdvancedOpen && (
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
                Resolution auto uses the largest source clip ({autoResolutionLabel}). FPS auto keeps source timing.
              </p>
              {!exportSupportsVideo && (
                <p className="hint">
                  This format is audio-only. Resolution, FPS, and canvas mode are ignored.
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
                ? "Audio-only formats ignore canvas mode."
                : exportMode === "fit"
                  ? "Fit Canvas keeps one output resolution and avoids stretching, but is slower."
                  : "Fast Copy is quickest and may stretch/mismatch when source resolutions differ."}
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
        )}
      </section>
    </main>
  );
}

export default App;
