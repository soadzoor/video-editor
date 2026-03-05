import { MIN_CROP_SIZE_PX, PAN_SNAP_THRESHOLD_PX } from "./constants";
import { clamp } from "./formatters";
import type { CropDragState, CropRect } from "./types";

export function normalizeCropRect(rect: CropRect, workspaceWidth: number, workspaceHeight: number): CropRect {
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

export function snapPanToCropEdges(
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

export function applyCropDrag(
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
