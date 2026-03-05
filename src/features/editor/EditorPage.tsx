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
  type ExportStage
} from "../../ffmpeg/export";
import { TimelinePreviewEngine, type PreviewClip, type PreviewSegment } from "../../preview-engine";
import CropInspectorPanel from "./components/CropInspectorPanel";
import EditorWorkspace from "./components/EditorWorkspace";
import ExportDock from "./components/ExportDock";
import MediaBinPanel from "./components/MediaBinPanel";
import PreviewStage from "./components/PreviewStage";
import SegmentInspectorPanel from "./components/SegmentInspectorPanel";
import TimelineDock from "./components/TimelineDock";
import { useCropInteractions } from "./hooks/useCropInteractions";
import { useExportController } from "./hooks/useExportController";
import { useGlobalFileDrop } from "./hooks/useGlobalFileDrop";
import { usePreviewEngine } from "./hooks/usePreviewEngine";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { applyCropDrag, normalizeCropRect, snapPanToCropEdges } from "./model/crop";
import {
  MIN_CROP_SIZE_PX,
  MIN_EDIT_GAP_SEC,
  PREVIEW_UI_POSITION_STEP_SEC,
  SEGMENT_END_EPSILON,
  TRIM_SNAP_STEP_SEC
} from "./model/constants";
import {
  clamp,
  clampPieceScale,
  clampSpeed,
  durationPartsFromSeconds,
  formatEta,
  formatScaleLabel,
  formatSpeedLabel,
  isKeyboardEventFromInteractiveElement,
  makeId,
  nearlyEqual,
  normalizePanValue,
  normalizeTimeValue,
  parseNonNegativeIntegerInput,
  parsePositiveIntegerInput,
  scaleToLogSliderValue,
  speedToLogSliderValue
} from "./model/formatters";
import {
  buildEditedSegments,
  buildTimelineDisplayItems,
  findSegmentIndex,
  moveTimelineItem,
  snapTimelineValueToTargets,
  timelineDurationFromItems
} from "./model/timeline";
import type {
  CropDragMode,
  CropRect,
  InspectorOpenState,
  PlayheadDragState,
  SourceClip,
  TimelineDisplayItem,
  TimelineItem,
  TimelineTool,
  TrimWindowDragState
} from "./model/types";

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

function EditorPage() {
  const [clips, setClips] = useState<SourceClip[]>([]);
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  const [isIngesting, setIsIngesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [trimStartSec, setTrimStartSec] = useState(0);
  const [trimEndSec, setTrimEndSec] = useState(0);
  const {
    isPlaying,
    setIsPlaying,
    previewPositionSec,
    setPreviewPositionSec,
    setCurrentSegmentIndex,
    isPreviewSupported,
    previewCanvasRef,
    previewSurfaceRef,
    previewEngineRef,
    previewSegmentsRef,
    isPlayingRef,
    togglePlayPauseRef,
    stepPreviewFrameRef,
    pendingFrameStepCountRef,
    isApplyingFrameStepRef
  } = usePreviewEngine();

  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
  const [draggingTimelineItemId, setDraggingTimelineItemId] = useState<string | null>(null);

  const {
    isExporting,
    setIsExporting,
    exportStage,
    setExportStage,
    exportStatusMessage,
    setExportStatusMessage,
    exportProgress,
    setExportProgress,
    exportFrameProgress,
    setExportFrameProgress,
    exportStartedAtMs,
    setExportStartedAtMs,
    exportNowMs,
    setExportNowMs,
    exportMode,
    setExportMode,
    exportFormat,
    setExportFormat,
    exportWidthInput,
    setExportWidthInput,
    exportHeightInput,
    setExportHeightInput,
    exportFpsInput,
    setExportFpsInput,
    includeVideoInExport,
    setIncludeVideoInExport,
    includeAudioInExport,
    setIncludeAudioInExport,
    exportVideoBitrateInput,
    setExportVideoBitrateInput,
    exportAudioBitrateInput,
    setExportAudioBitrateInput
  } = useExportController();
  const {
    dockTab,
    setDockTab,
    utilityTab,
    setUtilityTab,
    workspacePaneSizes,
    isLeftPanelCollapsed,
    setIsLeftPanelCollapsed,
    isRightPanelCollapsed,
    setIsRightPanelCollapsed,
    activeSplitter,
    isDesktopViewport,
    workstationStyle,
    handleSplitterPointerDown,
    resetSplitterSize
  } = useWorkspaceLayout();
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
  const {
    cropEnabled,
    setCropEnabled,
    cropLockAspect,
    setCropLockAspect,
    cropAspectRatio,
    setCropAspectRatio,
    cropRect,
    setCropRect,
    isDraggingCrop,
    setIsDraggingCrop,
    isDraggingPreviewPan,
    setIsDraggingPreviewPan,
    cropDragRef,
    previewPanDragRef,
    pendingCropRectRef,
    cropDragRafRef,
    pendingPreviewPanRef,
    previewPanRafRef,
    previousWorkspaceSizeRef,
    previousCropEnabledRef
  } = useCropInteractions();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const clipsRef = useRef<SourceClip[]>([]);
  const previousSelectedTimelineItemIdRef = useRef<string | null>(null);

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
  const selectedTimelineItemId = useMemo(() => {
    if (previewTimelineSegments.length === 0 || previewDurationSec <= 0) {
      return null;
    }
    const boundedPosition = clamp(previewPositionSec, 0, Math.max(0, previewDurationSec - 0.0001));
    const index = findSegmentIndex(previewTimelineSegments, boundedPosition);
    if (index < 0) {
      return null;
    }
    return previewTimelineSegments[index]?.timelineItemId ?? null;
  }, [previewDurationSec, previewPositionSec, previewTimelineSegments]);
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
        timelineItemId: segment.timelineItemId,
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
    const drag = previewPanDragRef.current;
    const pendingPan = pendingPreviewPanRef.current;
    pendingPreviewPanRef.current = null;
    if (!pendingPan || !drag) {
      return;
    }
    if (selectedTimelineItemId === drag.timelineItemId) {
      const panXText = normalizePanValue(pendingPan.panX).toString();
      const panYText = normalizePanValue(pendingPan.panY).toString();
      setSelectedPanXInput((previous) => (previous === panXText ? previous : panXText));
      setSelectedPanYInput((previous) => (previous === panYText ? previous : panYText));
    }
    setTimelineItemTransformById(drag.timelineItemId, {
      panX: pendingPan.panX,
      panY: pendingPan.panY
    });
  }

  function schedulePreviewPanUpdate(nextPan: { panX: number; panY: number }): void {
    pendingPreviewPanRef.current = {
      panX: normalizePanValue(nextPan.panX),
      panY: normalizePanValue(nextPan.panY)
    };
    if (previewPanRafRef.current !== null) {
      return;
    }
    previewPanRafRef.current = window.requestAnimationFrame(() => {
      previewPanRafRef.current = null;
      const drag = previewPanDragRef.current;
      const pendingPan = pendingPreviewPanRef.current;
      if (!pendingPan || !drag) {
        return;
      }
      if (selectedTimelineItemId === drag.timelineItemId) {
        const panXText = pendingPan.panX.toString();
        const panYText = pendingPan.panY.toString();
        setSelectedPanXInput((previous) => (previous === panXText ? previous : panXText));
        setSelectedPanYInput((previous) => (previous === panYText ? previous : panYText));
      }
      previewEngineRef.current?.updateTimelineItemTransform(drag.timelineItemId, {
        scale: drag.initialScale,
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
    if (draggingTimelineItemId && !timelineItems.some((item) => item.id === draggingTimelineItemId)) {
      setDraggingTimelineItemId(null);
    }
  }, [draggingTimelineItemId, timelineItems]);

  useEffect(() => {
    if (timelineTool !== "select" && draggingTimelineItemId) {
      setDraggingTimelineItemId(null);
    }
  }, [draggingTimelineItemId, timelineTool]);

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
    if (isBusy || timelineTool !== "select") {
      event.preventDefault();
      return;
    }

    setDraggingTimelineItemId(itemId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function handleTimelineItemDragOver(event: ReactDragEvent<HTMLButtonElement>): void {
    if (!draggingTimelineItemId || isBusy || timelineTool !== "select") {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleTimelineItemDrop(
    event: ReactDragEvent<HTMLButtonElement>,
    targetId: string
  ): void {
    if (!draggingTimelineItemId || isBusy || timelineTool !== "select") {
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

  function setTimelineItemTransformById(
    timelineItemId: string,
    next: {
      scale?: number;
      panX?: number;
      panY?: number;
    }
  ): void {
    if (!timelineItemId || isBusy) {
      return;
    }

    setTimelineItems((previous) => {
      let hasChanged = false;
      const nextItems = previous.map((item) => {
        if (item.id !== timelineItemId) {
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

  function setSelectedTimelineTransform(next: {
    scale?: number;
    panX?: number;
    panY?: number;
  }): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    setTimelineItemTransformById(selectedTimelineItemId, next);
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
    const initialScale = clampPieceScale(selectedTimelineItem.scale);
    const drawWidth = selectedClip.width * containScale * initialScale;
    const drawHeight = selectedClip.height * containScale * initialScale;
    const baseX = (workspaceWidth - drawWidth) / 2;
    const baseY = (workspaceHeight - drawHeight) / 2;

    event.preventDefault();
    event.stopPropagation();
    previewPanDragRef.current = {
      timelineItemId: selectedTimelineItem.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      overlayWidthPx: rect.width,
      overlayHeightPx: rect.height,
      workspaceWidth,
      workspaceHeight,
      initialScale,
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

  const { isDragging, bindings: globalFileDropBindings } = useGlobalFileDrop({
    onDropFiles: addVideos
  });

  const mediaBinContent = (
    <MediaBinPanel
      clips={clips}
      isBusy={isBusy}
      isDragging={isDragging}
      isIngesting={isIngesting}
      totalSourceDurationSec={totalSourceDurationSec}
      onImport={() => fileInputRef.current?.click()}
      onClear={clearQueue}
      onRemoveClip={removeClip}
    />
  );

  const previewStageContent = (
    <PreviewStage
      isPreviewSupported={isPreviewSupported}
      clipsLength={clips.length}
      cropEnabled={cropEnabled}
      isDraggingCrop={isDraggingCrop}
      isDraggingPreviewPan={isDraggingPreviewPan}
      hasSelectedTimelineItem={selectedTimelineItem !== null}
      previewSurfaceRef={previewSurfaceRef}
      previewCanvasRef={previewCanvasRef}
      cropRectPercent={cropRectPercent}
      cropMaskPercent={cropMaskPercent}
      isPlaying={isPlaying}
      previewPositionSec={previewPositionSec}
      previewDurationSec={previewDurationSec}
      currentPreviewFrame={currentPreviewFrame}
      totalPreviewFrames={totalPreviewFrames}
      isFrameReadoutEstimated={isFrameReadoutEstimated}
      timelineTool={timelineTool}
      isBusy={isBusy}
      hasPreviewSegments={previewTimelineSegments.length > 0}
      hasSelectedTimelineItemId={selectedTimelineItemId !== null}
      onTogglePlayPause={() => void togglePlayPause()}
      onSetTimelineTool={setTimelineTool}
      onDeletePiece={removeSelectedTimelinePiece}
      onPreviewPanPointerDown={handlePreviewPanPointerDown}
      onCropPointerDown={handleCropPointerDown}
    />
  );

  const timelineDockContent = (
    <TimelineDock
      timelineDurationSec={timelineDurationSec}
      timelineTool={timelineTool}
      trimRangeShellRef={trimRangeShellRef}
      trimStartPercent={trimStartPercent}
      trimRightPercent={trimRightPercent}
      timelineDisplayItems={timelineDisplayItems}
      clipById={clipById}
      selectedTimelineItemId={selectedTimelineItemId}
      draggingTimelineItemId={draggingTimelineItemId}
      isBusy={isBusy}
      isDraggingPlayhead={isDraggingPlayhead}
      playheadPercent={playheadPercent}
      isDraggingTrimEdge={isDraggingTrimEdge}
      activeTrimEdge={activeTrimEdge}
      trimStartSec={trimStartSec}
      trimEndSec={trimEndSec}
      onTimelineSegmentClick={handleTimelineSegmentClick}
      onTimelineItemDragStart={handleTimelineItemDragStart}
      onTimelineItemDragOver={handleTimelineItemDragOver}
      onTimelineItemDrop={handleTimelineItemDrop}
      onTimelineItemDragEnd={handleTimelineItemDragEnd}
      onPlayheadPointerDown={handlePlayheadPointerDown}
      onTrimEdgePointerDown={handleTrimEdgePointerDown}
    />
  );

  const exportDockContent = (
    <ExportDock
      isBusy={isBusy}
      exportFormat={exportFormat}
      exportFpsInput={exportFpsInput}
      exportWidthInput={exportWidthInput}
      exportHeightInput={exportHeightInput}
      exportSupportsVideo={exportSupportsVideo}
      exportSupportsAudio={exportSupportsAudio}
      largestClipResolution={largestClipResolution}
      advancedExportOpen={inspectorOpenState.advancedExport}
      disableVideoToggle={disableVideoToggle}
      disableAudioToggle={disableAudioToggle}
      effectiveIncludeVideo={effectiveIncludeVideo}
      effectiveIncludeAudio={effectiveIncludeAudio}
      exportVideoBitrateInput={exportVideoBitrateInput}
      exportAudioBitrateInput={exportAudioBitrateInput}
      autoResolutionLabel={autoResolutionLabel}
      normalizedCropRect={normalizedCropRect}
      exportMode={exportMode}
      isExporting={isExporting}
      hasEditedSegments={editedSegments.length > 0}
      exportStage={exportStage}
      exportStatusMessage={exportStatusMessage}
      exportProgress={exportProgress}
      exportProgressPercentText={exportProgressPercentText}
      exportFrameCountText={exportFrameCountText}
      exportEtaText={exportEtaText}
      onSetExportFormat={setExportFormat}
      onSetExportFpsInput={setExportFpsInput}
      onSetExportWidthInput={setExportWidthInput}
      onSetExportHeightInput={setExportHeightInput}
      onUseLargestSource={() => {
        if (largestClipResolution.area <= 0) {
          return;
        }
        setExportWidthInput(String(largestClipResolution.width));
        setExportHeightInput(String(largestClipResolution.height));
      }}
      onAutoWorkspace={() => {
        setExportWidthInput("");
        setExportHeightInput("");
      }}
      onToggleAdvanced={() =>
        setInspectorOpenState((previous) => ({
          ...previous,
          advancedExport: !previous.advancedExport
        }))
      }
      onSetIncludeVideo={(nextValue) => {
        if (!nextValue && !effectiveIncludeAudio) {
          return;
        }
        setIncludeVideoInExport(nextValue);
      }}
      onSetIncludeAudio={(nextValue) => {
        if (!nextValue && !effectiveIncludeVideo) {
          return;
        }
        setIncludeAudioInExport(nextValue);
      }}
      onSetExportVideoBitrateInput={setExportVideoBitrateInput}
      onSetExportAudioBitrateInput={setExportAudioBitrateInput}
      onSetExportMode={setExportMode}
      onExport={() => void handleExport()}
      exportStageLabel={exportStageLabel}
    />
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
    <CropInspectorPanel
      isBusy={isBusy}
      clipsLength={clips.length}
      exportSupportsVideo={exportSupportsVideo}
      cropEnabled={cropEnabled}
      cropLockAspect={cropLockAspect}
      normalizedCropRect={normalizedCropRect}
      inspectorOpenState={inspectorOpenState}
      onSetInspectorOpenState={setInspectorOpenState}
      onSetCropEnabled={setCropEnabled}
      onResetCropRect={resetCropRect}
      onSetCropLockAspect={setCropLockAspect}
      onSetCropAspectRatioToCurrent={() => {
        if (normalizedCropRect.height > 0) {
          setCropAspectRatio(normalizedCropRect.width / normalizedCropRect.height);
        }
      }}
      onSetCropField={setCropField}
    />
  );

  const inspectorContent = (
    <div className="inspector-stack">
      <SegmentInspectorPanel
        selectedTimelineItem={selectedTimelineItem}
        clipById={clipById}
        inspectorOpenState={inspectorOpenState}
        onSetInspectorOpenState={setInspectorOpenState}
        isBusy={isBusy}
        selectedSpeedInput={selectedSpeedInput}
        selectedDurationMinutesInput={selectedDurationMinutesInput}
        selectedDurationSecondsInput={selectedDurationSecondsInput}
        selectedDurationMillisecondsInput={selectedDurationMillisecondsInput}
        selectedScaleInput={selectedScaleInput}
        selectedPanXInput={selectedPanXInput}
        selectedPanYInput={selectedPanYInput}
        selectedSpeedSliderValue={selectedSpeedSliderValue}
        selectedScaleSliderValue={selectedScaleSliderValue}
        onHandleSelectedSpeedInputChange={handleSelectedSpeedInputChange}
        onCommitSelectedSpeedInput={commitSelectedSpeedInput}
        onSetSelectedTimelineSpeed={setSelectedTimelineSpeed}
        onHandleSelectedDurationInputChange={handleSelectedDurationInputChange}
        onCommitSelectedDurationInput={commitSelectedDurationInput}
        onHandleSelectedScaleInputChange={handleSelectedScaleInputChange}
        onCommitSelectedScaleInput={commitSelectedScaleInput}
        onSetSelectedTimelineTransform={setSelectedTimelineTransform}
        onHandleSelectedPanInputChange={handleSelectedPanInputChange}
        onCommitSelectedPanInput={commitSelectedPanInput}
        onFillSelectedPieceToCrop={fillSelectedPieceToCrop}
        onResetSelectedTransform={resetSelectedTransform}
      />
    </div>
  );

  return (
    <main
      className="app-shell"
      onDrop={globalFileDropBindings.onDrop}
      onDragEnter={globalFileDropBindings.onDragEnter}
      onDragOver={globalFileDropBindings.onDragOver}
      onDragLeave={globalFileDropBindings.onDragLeave}
    >
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

      <EditorWorkspace
        isDesktopViewport={isDesktopViewport}
        workstationStyle={workstationStyle}
        isLeftPanelCollapsed={isLeftPanelCollapsed}
        isRightPanelCollapsed={isRightPanelCollapsed}
        activeSplitter={activeSplitter}
        utilityTab={utilityTab}
        previewStageContent={previewStageContent}
        previewDockContent={previewDockContent}
        cropPanelContent={cropPanelContent}
        inspectorContent={inspectorContent}
        onSetIsLeftPanelCollapsed={setIsLeftPanelCollapsed}
        onSetIsRightPanelCollapsed={setIsRightPanelCollapsed}
        onHandleSplitterPointerDown={handleSplitterPointerDown}
        onResetSplitterSize={resetSplitterSize}
        onSetUtilityTab={setUtilityTab}
      />
    </main>
  );
}

export default EditorPage;
