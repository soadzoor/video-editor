import { useRef, useState, type ChangeEvent } from "react";
import { exportStageLabel } from "../model/exportUi";
import type { EditorControllerResult } from "../model/controller";
import type {
  InspectorOpenState,
  PlayheadDragState,
  SourceClip,
  TimelineItem,
  TimelineTool,
  TrimWindowDragState
} from "../model/types";
import { useCropInteractions } from "./useCropInteractions";
import { useEditorCropPanRuntime } from "./useEditorCropPanRuntime";
import { useEditorDerivedState } from "./useEditorDerivedState";
import { useEditorExportActions } from "./useEditorExportActions";
import { useEditorMediaActions } from "./useEditorMediaActions";
import { useEditorPlaybackActions } from "./useEditorPlaybackActions";
import { useEditorPreviewLifecycle } from "./useEditorPreviewLifecycle";
import { useEditorSegmentActions } from "./useEditorSegmentActions";
import { useEditorTimelineActions } from "./useEditorTimelineActions";
import { useEditorTimelineRuntime } from "./useEditorTimelineRuntime";
import { useEditorUiSyncEffects } from "./useEditorUiSyncEffects";
import { useExportController } from "./useExportController";
import { useGlobalFileDrop } from "./useGlobalFileDrop";
import { usePreviewEngine } from "./usePreviewEngine";
import { useWorkspaceLayout } from "./useWorkspaceLayout";

export function useEditorController(): EditorControllerResult {
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

  const {
    clipById,
    largestClipResolution,
    timelineDisplayItems,
    timelineDurationSec,
    editedSegments,
    previewTimelineSegments,
    previewDurationSec,
    selectedTimelineItemId,
    selectedTimelineItem,
    hasEditedResolutionMismatch,
    workspaceWidth,
    workspaceHeight,
    exportFormatConfig,
    exportSupportsVideo,
    exportSupportsAudio,
    effectiveIncludeVideo,
    effectiveIncludeAudio,
    frameReadoutFps,
    isFrameReadoutEstimated,
    totalPreviewFrames,
    currentPreviewFrame,
    trimStartPercent,
    trimRightPercent,
    playheadRawSec,
    playheadPercent,
    selectedSpeedSliderValue,
    selectedScaleSliderValue,
    isBusy,
    disableVideoToggle,
    disableAudioToggle,
    exportProgressPercentText,
    exportFrameCountText,
    exportEtaText,
    autoResolutionLabel,
    totalSourceDurationSec,
    previewClips,
    previewSegments,
    normalizedCropRect,
    cropRectPercent,
    cropMaskPercent
  } = useEditorDerivedState({
    clips,
    timelineItems,
    trimStartSec,
    trimEndSec,
    previewPositionSec,
    exportFormat,
    exportWidthInput,
    exportHeightInput,
    exportFpsInput,
    includeVideoInExport,
    includeAudioInExport,
    isIngesting,
    isExporting,
    exportProgress,
    exportFrameProgress,
    exportStartedAtMs,
    exportNowMs,
    cropRect
  });

  const { addVideos, handleFileInput, removeClip, clearQueue } = useEditorMediaActions({
    clips,
    timelineItems,
    setClips,
    setTimelineItems,
    setIsIngesting,
    setError,
    setTrimStartSec,
    setTrimEndSec,
    setPreviewPositionSec,
    setCurrentSegmentIndex,
    setIsPlaying,
    previewEngineRef,
    skipTrimRescaleRef,
    setExportProgress,
    setExportFrameProgress,
    setExportStartedAtMs,
    setExportStage,
    setExportStatusMessage,
    setDraggingTimelineItemId,
    setCropEnabled,
    setCropRect,
    previousWorkspaceSizeRef,
    fileInputRef
  });
  const exportSegments =
    editedSegments.length > 0 ? editedSegments : previewTimelineSegments;

  const { seekToTimelinePosition, togglePlayPause } = useEditorPlaybackActions({
    previewTimelineSegments,
    previewDurationSec,
    timelineDurationSec,
    frameReadoutFps,
    isPlaying,
    previewEngineRef,
    isPlayingRef,
    togglePlayPauseRef,
    stepPreviewFrameRef,
    pendingFrameStepCountRef,
    isApplyingFrameStepRef,
    setPreviewPositionSec,
    setCurrentSegmentIndex,
    setIsPlaying,
    setError
  });

  const {
    handleTimelineSegmentClick,
    handleTrimEdgePointerDown,
    handlePlayheadPointerDown,
    handleTimelineItemDragStart,
    handleTimelineItemDragOver,
    handleTimelineItemDrop,
    handleTimelineItemDragEnd,
    removeSelectedTimelinePiece
  } = useEditorTimelineActions({
    isBusy,
    isPlaying,
    timelineTool,
    timelineDurationSec,
    timelineDisplayItems,
    previewTimelineSegments,
    trimStartSec,
    trimEndSec,
    selectedTimelineItemId,
    draggingTimelineItemId,
    trimRangeShellRef,
    trimWindowDragRef,
    playheadDragRef,
    previewEngineRef,
    setTimelineItems,
    setError,
    setIsPlaying,
    setIsDraggingTrimEdge,
    setActiveTrimEdge,
    setIsDraggingPlayhead,
    setDraggingTimelineItemId,
    seekToTimelinePosition
  });

  const { handleExport } = useEditorExportActions({
    editedSegments: exportSegments,
    isBusy,
    effectiveIncludeVideo,
    effectiveIncludeAudio,
    exportWidthInput,
    exportHeightInput,
    exportFpsInput,
    exportVideoBitrateInput,
    exportAudioBitrateInput,
    exportMode,
    exportFormat,
    exportFormatConfig,
    workspaceWidth,
    workspaceHeight,
    cropEnabled,
    normalizedCropRect,
    clipById,
    setError,
    setIsExporting,
    setExportStage,
    setExportStatusMessage,
    setExportProgress,
    setExportFrameProgress,
    setExportStartedAtMs,
    setExportNowMs
  });

  const {
    setSelectedTimelineSpeed,
    setTimelineItemTransformById,
    setSelectedTimelineTransform,
    handleSelectedSpeedInputChange,
    commitSelectedSpeedInput,
    handleSelectedDurationInputChange,
    commitSelectedDurationInput,
    handleSelectedScaleInputChange,
    commitSelectedScaleInput,
    handleSelectedPanInputChange,
    commitSelectedPanInput,
    resetSelectedTransform,
    fillSelectedPieceToCrop
  } = useEditorSegmentActions({
    selectedTimelineItemId,
    selectedTimelineItem,
    isBusy,
    setTimelineItems,
    setError,
    selectedSpeedInput,
    setSelectedSpeedInput,
    selectedDurationMinutesInput,
    setSelectedDurationMinutesInput,
    selectedDurationSecondsInput,
    setSelectedDurationSecondsInput,
    selectedDurationMillisecondsInput,
    setSelectedDurationMillisecondsInput,
    selectedScaleInput,
    setSelectedScaleInput,
    selectedPanXInput,
    setSelectedPanXInput,
    selectedPanYInput,
    setSelectedPanYInput,
    clipById,
    workspaceWidth,
    workspaceHeight,
    normalizedCropRect
  });
  const clipsLength = clips.length;

  const {
    setCropField,
    resetCropRect,
    handleCropPointerDown,
    handlePreviewPanPointerDown
  } = useEditorCropPanRuntime({
    isBusy,
    cropEnabled,
    cropLockAspect,
    cropAspectRatio,
    clipsLength,
    workspaceWidth,
    workspaceHeight,
    normalizedCropRect,
    selectedTimelineItemId,
    selectedTimelineItem,
    clipById,
    previewSurfaceRef,
    previewEngineRef,
    cropDragRef,
    previewPanDragRef,
    pendingCropRectRef,
    cropDragRafRef,
    pendingPreviewPanRef,
    previewPanRafRef,
    isDraggingCrop,
    setIsDraggingCrop,
    isDraggingPreviewPan,
    setIsDraggingPreviewPan,
    setCropRect,
    setTimelineItemTransformById,
    setSelectedPanXInput,
    setSelectedPanYInput
  });

  useEditorTimelineRuntime({
    timelineDurationSec,
    trimStartSec,
    trimEndSec,
    playheadRawSec,
    isBusy,
    isDraggingTrimEdge,
    trimWindowDragRef,
    setIsDraggingTrimEdge,
    setActiveTrimEdge,
    isDraggingPlayhead,
    playheadDragRef,
    setIsDraggingPlayhead,
    seekToTimelinePosition,
    setTrimStartSec,
    setTrimEndSec,
    previousTimelineDurationRef,
    skipTrimRescaleRef
  });

  useEditorPreviewLifecycle({
    isPreviewSupported,
    previewCanvasRef,
    previewEngineRef,
    previewSegmentsRef,
    isPlayingRef,
    setPreviewPositionSec,
    setCurrentSegmentIndex,
    setIsPlaying,
    setError,
    previewClips,
    previewSegments,
    workspaceWidth,
    workspaceHeight,
    dockTab,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    workspacePaneSizes,
    previewTimelineSegments,
    previewDurationSec,
    previewPositionSec
  });

  useEditorUiSyncEffects({
    clips,
    clipsRef,
    cropDragRafRef,
    previewPanRafRef,
    pendingCropRectRef,
    pendingPreviewPanRef,
    previewTimelineSegments,
    previewSegmentsRef,
    selectedTimelineItemId,
    previousSelectedTimelineItemIdRef,
    setInspectorOpenState,
    cropEnabled,
    previousCropEnabledRef,
    setCropRect,
    previousWorkspaceSizeRef,
    workspaceWidth,
    workspaceHeight,
    cropLockAspect,
    normalizedCropRect,
    setCropAspectRatio,
    exportSupportsVideo,
    hasEditedResolutionMismatch,
    setExportMode,
    isExporting,
    setExportNowMs,
    draggingTimelineItemId,
    timelineItems,
    timelineTool,
    setDraggingTimelineItemId,
    selectedTimelineItem,
    isDraggingPreviewPan,
    setSelectedSpeedInput,
    setSelectedDurationMinutesInput,
    setSelectedDurationSecondsInput,
    setSelectedDurationMillisecondsInput,
    setSelectedScaleInput,
    setSelectedPanXInput,
    setSelectedPanYInput,
    previewEngineRef,
    togglePlayPauseRef,
    stepPreviewFrameRef
  });

  const { isDragging, bindings: globalFileDropBindings } = useGlobalFileDrop({
    onDropFiles: addVideos
  });

  const hasPreviewSegments = previewTimelineSegments.length > 0;
  const hasSelectedTimelineItem = selectedTimelineItem !== null;
  const hasSelectedTimelineItemId = selectedTimelineItemId !== null;
  const hasEditedSegments = exportSegments.length > 0;

  const fileInputProps: EditorControllerResult["fileInputProps"] = {
    ref: fileInputRef,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      void handleFileInput(event);
    }
  };

  const mediaBinProps: EditorControllerResult["mediaBinProps"] = {
    clips,
    isBusy,
    isDragging,
    isIngesting,
    totalSourceDurationSec,
    onImport: () => fileInputRef.current?.click(),
    onClear: clearQueue,
    onRemoveClip: removeClip
  };

  const previewStageProps: EditorControllerResult["previewStageProps"] = {
    isPreviewSupported,
    clipsLength,
    cropEnabled,
    isDraggingCrop,
    isDraggingPreviewPan,
    hasSelectedTimelineItem,
    previewSurfaceRef,
    previewCanvasRef,
    cropRectPercent,
    cropMaskPercent,
    isPlaying,
    previewPositionSec,
    previewDurationSec,
    currentPreviewFrame,
    totalPreviewFrames,
    isFrameReadoutEstimated,
    timelineTool,
    isBusy,
    hasPreviewSegments,
    hasSelectedTimelineItemId,
    onTogglePlayPause: () => {
      void togglePlayPause();
    },
    onSetTimelineTool: setTimelineTool,
    onDeletePiece: removeSelectedTimelinePiece,
    onPreviewPanPointerDown: handlePreviewPanPointerDown,
    onCropPointerDown: handleCropPointerDown
  };

  const timelineDockProps: EditorControllerResult["timelineDockProps"] = {
    timelineDurationSec,
    timelineTool,
    trimRangeShellRef,
    trimStartPercent,
    trimRightPercent,
    timelineDisplayItems,
    clipById,
    selectedTimelineItemId,
    draggingTimelineItemId,
    isBusy,
    isDraggingPlayhead,
    playheadPercent,
    isDraggingTrimEdge,
    activeTrimEdge,
    trimStartSec,
    trimEndSec,
    onTimelineSegmentClick: handleTimelineSegmentClick,
    onTimelineItemDragStart: handleTimelineItemDragStart,
    onTimelineItemDragOver: handleTimelineItemDragOver,
    onTimelineItemDrop: handleTimelineItemDrop,
    onTimelineItemDragEnd: handleTimelineItemDragEnd,
    onPlayheadPointerDown: handlePlayheadPointerDown,
    onTrimEdgePointerDown: handleTrimEdgePointerDown
  };

  const exportDockProps: EditorControllerResult["exportDockProps"] = {
    isBusy,
    exportFormat,
    exportFpsInput,
    exportWidthInput,
    exportHeightInput,
    exportSupportsVideo,
    exportSupportsAudio,
    largestClipResolution,
    advancedExportOpen: inspectorOpenState.advancedExport,
    disableVideoToggle,
    disableAudioToggle,
    effectiveIncludeVideo,
    effectiveIncludeAudio,
    exportVideoBitrateInput,
    exportAudioBitrateInput,
    autoResolutionLabel,
    normalizedCropRect,
    exportMode,
    isExporting,
    hasEditedSegments,
    exportStage,
    exportStatusMessage,
    exportProgress,
    exportProgressPercentText,
    exportFrameCountText,
    exportEtaText,
    onSetExportFormat: setExportFormat,
    onSetExportFpsInput: setExportFpsInput,
    onSetExportWidthInput: setExportWidthInput,
    onSetExportHeightInput: setExportHeightInput,
    onUseLargestSource: () => {
      if (largestClipResolution.area <= 0) {
        return;
      }
      setExportWidthInput(String(largestClipResolution.width));
      setExportHeightInput(String(largestClipResolution.height));
    },
    onAutoWorkspace: () => {
      setExportWidthInput("");
      setExportHeightInput("");
    },
    onToggleAdvanced: () =>
      setInspectorOpenState((previous) => ({
        ...previous,
        advancedExport: !previous.advancedExport
      })),
    onSetIncludeVideo: (nextValue: boolean) => {
      if (!nextValue && !effectiveIncludeAudio) {
        return;
      }
      setIncludeVideoInExport(nextValue);
    },
    onSetIncludeAudio: (nextValue: boolean) => {
      if (!nextValue && !effectiveIncludeVideo) {
        return;
      }
      setIncludeAudioInExport(nextValue);
    },
    onSetExportVideoBitrateInput: setExportVideoBitrateInput,
    onSetExportAudioBitrateInput: setExportAudioBitrateInput,
    onSetExportMode: setExportMode,
    onExport: () => {
      void handleExport();
    },
    exportStageLabel
  };

  const previewDockTabProps: EditorControllerResult["previewDockTabProps"] = {
    dockTab,
    onSetDockTab: setDockTab
  };

  const cropInspectorProps: EditorControllerResult["cropInspectorProps"] = {
    isBusy,
    clipsLength,
    exportSupportsVideo,
    cropEnabled,
    cropLockAspect,
    normalizedCropRect,
    inspectorOpenState,
    onSetInspectorOpenState: setInspectorOpenState,
    onSetCropEnabled: setCropEnabled,
    onResetCropRect: resetCropRect,
    onSetCropLockAspect: setCropLockAspect,
    onSetCropAspectRatioToCurrent: () => {
      if (normalizedCropRect.height > 0) {
        setCropAspectRatio(normalizedCropRect.width / normalizedCropRect.height);
      }
    },
    onSetCropField: setCropField
  };

  const segmentInspectorProps: EditorControllerResult["segmentInspectorProps"] = {
    selectedTimelineItem,
    clipById,
    inspectorOpenState,
    onSetInspectorOpenState: setInspectorOpenState,
    isBusy,
    selectedSpeedInput,
    selectedDurationMinutesInput,
    selectedDurationSecondsInput,
    selectedDurationMillisecondsInput,
    selectedScaleInput,
    selectedPanXInput,
    selectedPanYInput,
    selectedSpeedSliderValue,
    selectedScaleSliderValue,
    onHandleSelectedSpeedInputChange: handleSelectedSpeedInputChange,
    onCommitSelectedSpeedInput: commitSelectedSpeedInput,
    onSetSelectedTimelineSpeed: setSelectedTimelineSpeed,
    onHandleSelectedDurationInputChange: handleSelectedDurationInputChange,
    onCommitSelectedDurationInput: commitSelectedDurationInput,
    onHandleSelectedScaleInputChange: handleSelectedScaleInputChange,
    onCommitSelectedScaleInput: commitSelectedScaleInput,
    onSetSelectedTimelineTransform: setSelectedTimelineTransform,
    onHandleSelectedPanInputChange: handleSelectedPanInputChange,
    onCommitSelectedPanInput: commitSelectedPanInput,
    onFillSelectedPieceToCrop: fillSelectedPieceToCrop,
    onResetSelectedTransform: resetSelectedTransform
  };

  const workspaceLayoutProps: EditorControllerResult["workspaceLayoutProps"] = {
    isDesktopViewport,
    workstationStyle,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    activeSplitter,
    utilityTab,
    onSetIsLeftPanelCollapsed: setIsLeftPanelCollapsed,
    onSetIsRightPanelCollapsed: setIsRightPanelCollapsed,
    onHandleSplitterPointerDown: handleSplitterPointerDown,
    onResetSplitterSize: resetSplitterSize,
    onSetUtilityTab: setUtilityTab
  };

  return {
    error,
    fileInputProps,
    globalFileDropBindings,
    mediaBinProps,
    previewStageProps,
    timelineDockProps,
    exportDockProps,
    previewDockTabProps,
    cropInspectorProps,
    segmentInspectorProps,
    workspaceLayoutProps
  };
}
