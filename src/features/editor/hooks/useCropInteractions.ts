import { useRef, useState } from "react";
import type { CropDragState, CropRect, PreviewPanDragState } from "../model/types";

export function useCropInteractions() {
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

  const cropDragRef = useRef<CropDragState | null>(null);
  const previewPanDragRef = useRef<PreviewPanDragState | null>(null);
  const pendingCropRectRef = useRef<CropRect | null>(null);
  const cropDragRafRef = useRef<number | null>(null);
  const pendingPreviewPanRef = useRef<{ panX: number; panY: number } | null>(null);
  const previewPanRafRef = useRef<number | null>(null);
  const previousWorkspaceSizeRef = useRef<{ width: number; height: number } | null>(null);
  const previousCropEnabledRef = useRef(false);

  return {
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
  };
}
