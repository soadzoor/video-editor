import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction
} from "react";
import type { TimelinePreviewEngine } from "../../../preview-engine";
import { applyCropDrag, normalizeCropRect, snapPanToCropEdges } from "../model/crop";
import { MIN_CROP_SIZE_PX } from "../model/constants";
import { clampPieceScale, normalizePanValue } from "../model/formatters";
import type {
  CropDragMode,
  CropDragState,
  CropRect,
  PreviewPanDragState,
  SourceClip,
  TimelineDisplayItem
} from "../model/types";

export interface UseEditorCropPanRuntimeParams {
  isBusy: boolean;
  cropEnabled: boolean;
  cropLockAspect: boolean;
  cropAspectRatio: number;
  clipsLength: number;
  workspaceWidth: number;
  workspaceHeight: number;
  normalizedCropRect: CropRect;
  selectedTimelineItemId: string | null;
  selectedTimelineItem: TimelineDisplayItem | null;
  clipById: Map<string, SourceClip>;
  previewSurfaceRef: MutableRefObject<HTMLDivElement | null>;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  cropDragRef: MutableRefObject<CropDragState | null>;
  previewPanDragRef: MutableRefObject<PreviewPanDragState | null>;
  pendingCropRectRef: MutableRefObject<CropRect | null>;
  cropDragRafRef: MutableRefObject<number | null>;
  pendingPreviewPanRef: MutableRefObject<{ panX: number; panY: number } | null>;
  previewPanRafRef: MutableRefObject<number | null>;
  isDraggingCrop: boolean;
  setIsDraggingCrop: Dispatch<SetStateAction<boolean>>;
  isDraggingPreviewPan: boolean;
  setIsDraggingPreviewPan: Dispatch<SetStateAction<boolean>>;
  setCropRect: Dispatch<SetStateAction<CropRect>>;
  setTimelineItemTransformById: (
    timelineItemId: string,
    next: { scale?: number; panX?: number; panY?: number }
  ) => void;
  setSelectedPanXInput: Dispatch<SetStateAction<string>>;
  setSelectedPanYInput: Dispatch<SetStateAction<string>>;
}

export interface UseEditorCropPanRuntimeResult {
  setCropField: (field: "x" | "y" | "width" | "height", value: string) => void;
  resetCropRect: () => void;
  handleCropPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    mode: CropDragMode
  ) => void;
  handlePreviewPanPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function useEditorCropPanRuntime({
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
}: UseEditorCropPanRuntimeParams): UseEditorCropPanRuntimeResult {
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

  function applyCropRect(nextRect: CropRect): void {
    setCropRect(normalizeCropRect(nextRect, workspaceWidth, workspaceHeight));
  }

  function setCropField(field: "x" | "y" | "width" | "height", value: string): void {
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
      clipsLength === 0 ||
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
      clipsLength === 0 ||
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

    if (isBusy || !cropEnabled || clipsLength === 0) {
      flushPendingCropRect();
      cropDragRef.current = null;
      setIsDraggingCrop(false);
    }
  }, [clipsLength, cropEnabled, isBusy, isDraggingCrop]);

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

    if (isBusy || !cropEnabled || !selectedTimelineItem || clipsLength === 0) {
      flushPendingPreviewPan();
      previewPanDragRef.current = null;
      setIsDraggingPreviewPan(false);
    }
  }, [clipsLength, cropEnabled, isBusy, isDraggingPreviewPan, selectedTimelineItem]);

  return {
    setCropField,
    resetCropRect,
    handleCropPointerDown,
    handlePreviewPanPointerDown
  };
}
