import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type { ExportMode } from "../../../ffmpeg/export";
import type { TimelinePreviewEngine } from "../../../preview-engine";
import { normalizeCropRect } from "../model/crop";
import {
  durationPartsFromSeconds,
  formatScaleLabel,
  formatSpeedLabel,
  isKeyboardEventFromInteractiveElement,
  nearlyEqual,
  normalizePanValue
} from "../model/formatters";
import type {
  CropRect,
  EditedSegment,
  InspectorOpenState,
  SourceClip,
  TimelineDisplayItem,
  TimelineItem,
  TimelineTool
} from "../model/types";

export interface UseEditorUiSyncEffectsParams {
  clips: SourceClip[];
  clipsRef: MutableRefObject<SourceClip[]>;
  cropDragRafRef: MutableRefObject<number | null>;
  previewPanRafRef: MutableRefObject<number | null>;
  pendingCropRectRef: MutableRefObject<CropRect | null>;
  pendingPreviewPanRef: MutableRefObject<{ panX: number; panY: number } | null>;
  previewTimelineSegments: EditedSegment[];
  previewSegmentsRef: MutableRefObject<EditedSegment[]>;
  selectedTimelineItemId: string | null;
  previousSelectedTimelineItemIdRef: MutableRefObject<string | null>;
  setInspectorOpenState: Dispatch<SetStateAction<InspectorOpenState>>;
  cropEnabled: boolean;
  previousCropEnabledRef: MutableRefObject<boolean>;
  setCropRect: Dispatch<SetStateAction<CropRect>>;
  previousWorkspaceSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  workspaceWidth: number;
  workspaceHeight: number;
  cropLockAspect: boolean;
  normalizedCropRect: CropRect;
  setCropAspectRatio: Dispatch<SetStateAction<number>>;
  exportSupportsVideo: boolean;
  hasEditedResolutionMismatch: boolean;
  setExportMode: Dispatch<SetStateAction<ExportMode>>;
  isExporting: boolean;
  setExportNowMs: Dispatch<SetStateAction<number>>;
  draggingTimelineItemId: string | null;
  timelineItems: TimelineItem[];
  timelineTool: TimelineTool;
  setDraggingTimelineItemId: Dispatch<SetStateAction<string | null>>;
  selectedTimelineItem: TimelineDisplayItem | null;
  isDraggingPreviewPan: boolean;
  setSelectedSpeedInput: Dispatch<SetStateAction<string>>;
  setSelectedDurationMinutesInput: Dispatch<SetStateAction<string>>;
  setSelectedDurationSecondsInput: Dispatch<SetStateAction<string>>;
  setSelectedDurationMillisecondsInput: Dispatch<SetStateAction<string>>;
  setSelectedScaleInput: Dispatch<SetStateAction<string>>;
  setSelectedPanXInput: Dispatch<SetStateAction<string>>;
  setSelectedPanYInput: Dispatch<SetStateAction<string>>;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  togglePlayPauseRef: MutableRefObject<() => void>;
  stepPreviewFrameRef: MutableRefObject<(direction: -1 | 1) => void>;
}

export function useEditorUiSyncEffects({
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
}: UseEditorUiSyncEffectsParams): void {
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
  }, [setCropRect, previousWorkspaceSizeRef, workspaceHeight, workspaceWidth]);

  useEffect(() => {
    if (!cropLockAspect || normalizedCropRect.height <= 0) {
      return;
    }

    const nextRatio = normalizedCropRect.width / normalizedCropRect.height;
    setCropAspectRatio((previous) => (nearlyEqual(previous, nextRatio) ? previous : nextRatio));
  }, [cropLockAspect, normalizedCropRect.height, normalizedCropRect.width, setCropAspectRatio]);

  useEffect(() => {
    if (!exportSupportsVideo || !hasEditedResolutionMismatch) {
      return;
    }

    setExportMode((previous) => (previous === "fit" ? previous : "fit"));
  }, [exportSupportsVideo, hasEditedResolutionMismatch, setExportMode]);

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
  }, [isExporting, setExportNowMs]);

  useEffect(() => {
    if (draggingTimelineItemId && !timelineItems.some((item) => item.id === draggingTimelineItemId)) {
      setDraggingTimelineItemId(null);
    }
  }, [draggingTimelineItemId, setDraggingTimelineItemId, timelineItems]);

  useEffect(() => {
    if (timelineTool !== "select" && draggingTimelineItemId) {
      setDraggingTimelineItemId(null);
    }
  }, [draggingTimelineItemId, setDraggingTimelineItemId, timelineTool]);

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
    selectedTimelineItem?.duration,
    selectedTimelineItem?.panX,
    selectedTimelineItem?.panY,
    selectedTimelineItem?.scale,
    selectedTimelineItem?.speed,
    setSelectedDurationMillisecondsInput,
    setSelectedDurationMinutesInput,
    setSelectedDurationSecondsInput,
    setSelectedPanXInput,
    setSelectedPanYInput,
    setSelectedScaleInput,
    setSelectedSpeedInput
  ]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      const isArrowLeft = event.key === "ArrowLeft";
      const isArrowRight = event.key === "ArrowRight";
      const isFrameStep = isArrowLeft || isArrowRight;
      const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
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
  }, [previewEngineRef, previewSegmentsRef, stepPreviewFrameRef, togglePlayPauseRef]);
}
