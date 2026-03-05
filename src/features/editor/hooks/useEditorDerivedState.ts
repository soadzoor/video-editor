import { useMemo } from "react";
import { getExportFormatConfig, type ExportFormat } from "../../../ffmpeg/export";
import type { PreviewClip, PreviewSegment } from "../../../preview-engine";
import { normalizeCropRect } from "../model/crop";
import { MIN_EDIT_GAP_SEC } from "../model/constants";
import {
  clamp,
  formatEta,
  parsePositiveIntegerInput,
  scaleToLogSliderValue,
  speedToLogSliderValue
} from "../model/formatters";
import {
  buildEditedSegments,
  buildTimelineDisplayItems,
  findSegmentIndex
} from "../model/timeline";
import type {
  CropRect,
  EditedSegment,
  SourceClip,
  TimelineDisplayItem,
  TimelineItem
} from "../model/types";

interface ExportFrameProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
}

interface LargestClipResolution {
  area: number;
  width: number;
  height: number;
}

interface CropRectPercent {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CropMaskPercent {
  right: number;
  bottom: number;
}

export interface UseEditorDerivedStateParams {
  clips: SourceClip[];
  timelineItems: TimelineItem[];
  trimStartSec: number;
  trimEndSec: number;
  previewPositionSec: number;
  exportFormat: ExportFormat;
  exportWidthInput: string;
  exportHeightInput: string;
  exportFpsInput: string;
  includeVideoInExport: boolean;
  includeAudioInExport: boolean;
  isIngesting: boolean;
  isExporting: boolean;
  exportProgress: number;
  exportFrameProgress: ExportFrameProgress | null;
  exportStartedAtMs: number | null;
  exportNowMs: number;
  cropRect: CropRect;
}

export interface UseEditorDerivedStateResult {
  clipById: Map<string, SourceClip>;
  largestClipResolution: LargestClipResolution;
  timelineDisplayItems: TimelineDisplayItem[];
  timelineDurationSec: number;
  editedSegments: EditedSegment[];
  previewTimelineSegments: EditedSegment[];
  previewDurationSec: number;
  selectedTimelineItemId: string | null;
  selectedTimelineItem: TimelineDisplayItem | null;
  hasEditedResolutionMismatch: boolean;
  workspaceWidth: number;
  workspaceHeight: number;
  exportFormatConfig: ReturnType<typeof getExportFormatConfig>;
  exportSupportsVideo: boolean;
  exportSupportsAudio: boolean;
  effectiveIncludeVideo: boolean;
  effectiveIncludeAudio: boolean;
  frameReadoutFps: number;
  isFrameReadoutEstimated: boolean;
  totalPreviewFrames: number;
  currentPreviewFrame: number;
  minTrimGapSec: number;
  trimStartPercent: number;
  trimRightPercent: number;
  playheadRawSec: number;
  playheadPercent: number;
  selectedSpeedSliderValue: number;
  selectedScaleSliderValue: number;
  isBusy: boolean;
  disableVideoToggle: boolean;
  disableAudioToggle: boolean;
  exportProgressPercentText: string;
  exportFrameCountText: string | null;
  exportEtaText: string | null;
  autoResolutionLabel: string;
  totalSourceDurationSec: number;
  previewClips: PreviewClip[];
  previewSegments: PreviewSegment[];
  normalizedCropRect: CropRect;
  cropRectPercent: CropRectPercent;
  cropMaskPercent: CropMaskPercent;
}

export function useEditorDerivedState({
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
}: UseEditorDerivedStateParams): UseEditorDerivedStateResult {
  const clipById = useMemo(() => {
    return new Map(clips.map((clip) => [clip.id, clip]));
  }, [clips]);

  const largestClipResolution = useMemo<LargestClipResolution>(() => {
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

  const selectedTimelineItem = selectedTimelineItemId
    ? timelineDisplayItems.find((item) => item.id === selectedTimelineItemId) ?? null
    : null;

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
    timelineDurationSec > 0
      ? (clamp(playheadRawSec, 0, timelineDurationSec) / timelineDurationSec) * 100
      : 0;

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

  return {
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
    minTrimGapSec,
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
  };
}
