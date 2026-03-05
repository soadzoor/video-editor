import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { formatDuration } from "../model/formatters";
import type { CropDragMode, TimelineTool } from "../model/types";

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

export interface PreviewStageProps {
  isPreviewSupported: boolean;
  clipsLength: number;
  cropEnabled: boolean;
  isDraggingCrop: boolean;
  isDraggingPreviewPan: boolean;
  hasSelectedTimelineItem: boolean;
  previewSurfaceRef: RefObject<HTMLDivElement | null>;
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  cropRectPercent: CropRectPercent;
  cropMaskPercent: CropMaskPercent;
  isPlaying: boolean;
  previewPositionSec: number;
  previewDurationSec: number;
  currentPreviewFrame: number;
  totalPreviewFrames: number;
  isFrameReadoutEstimated: boolean;
  timelineTool: TimelineTool;
  isBusy: boolean;
  hasPreviewSegments: boolean;
  hasSelectedTimelineItemId: boolean;
  onTogglePlayPause: () => void;
  onSetTimelineTool: (tool: TimelineTool) => void;
  onDeletePiece: () => void;
  onPreviewPanPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onCropPointerDown: (event: ReactPointerEvent<HTMLElement>, mode: CropDragMode) => void;
}

function PreviewStage({
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
  onTogglePlayPause,
  onSetTimelineTool,
  onDeletePiece,
  onPreviewPanPointerDown,
  onCropPointerDown
}: PreviewStageProps) {
  return (
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
            {clipsLength > 0 && cropEnabled && (
              <div
                className={`crop-overlay${isDraggingCrop ? " dragging" : ""}${
                  isDraggingPreviewPan ? " panning" : ""
                }${hasSelectedTimelineItem ? " has-pan" : ""}`}
              >
                <div
                  className="crop-mask-pane crop-mask-pane-top"
                  style={{ top: "0%", left: "0%", width: "100%", height: `${cropRectPercent.top}%` }}
                  onPointerDown={onPreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-left"
                  style={{
                    top: `${cropRectPercent.top}%`,
                    left: "0%",
                    width: `${cropRectPercent.left}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={onPreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-right"
                  style={{
                    top: `${cropRectPercent.top}%`,
                    left: `${cropRectPercent.left + cropRectPercent.width}%`,
                    width: `${cropMaskPercent.right}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={onPreviewPanPointerDown}
                />
                <div
                  className="crop-mask-pane crop-mask-pane-bottom"
                  style={{
                    top: `${cropRectPercent.top + cropRectPercent.height}%`,
                    left: "0%",
                    width: "100%",
                    height: `${cropMaskPercent.bottom}%`
                  }}
                  onPointerDown={onPreviewPanPointerDown}
                />
                <div
                  className="crop-window"
                  style={{
                    left: `${cropRectPercent.left}%`,
                    top: `${cropRectPercent.top}%`,
                    width: `${cropRectPercent.width}%`,
                    height: `${cropRectPercent.height}%`
                  }}
                  onPointerDown={(event) => onCropPointerDown(event, "move")}
                >
                  <span
                    className="crop-handle crop-handle-edge crop-handle-top"
                    onPointerDown={(event) => onCropPointerDown(event, "top")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-right"
                    onPointerDown={(event) => onCropPointerDown(event, "right")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-bottom"
                    onPointerDown={(event) => onCropPointerDown(event, "bottom")}
                  />
                  <span
                    className="crop-handle crop-handle-edge crop-handle-left"
                    onPointerDown={(event) => onCropPointerDown(event, "left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-top-left"
                    onPointerDown={(event) => onCropPointerDown(event, "top-left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-top-right"
                    onPointerDown={(event) => onCropPointerDown(event, "top-right")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-bottom-left"
                    onPointerDown={(event) => onCropPointerDown(event, "bottom-left")}
                  />
                  <span
                    className="crop-handle crop-handle-corner crop-handle-bottom-right"
                    onPointerDown={(event) => onCropPointerDown(event, "bottom-right")}
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
        {isPreviewSupported && clipsLength === 0 && (
          <div className="preview-empty">
            <p>Add videos to start editing.</p>
          </div>
        )}
      </div>

      <div className="preview-transport">
        <button
          className="button primary"
          type="button"
          onClick={onTogglePlayPause}
          disabled={!hasPreviewSegments}
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
            onClick={() => onSetTimelineTool("select")}
            disabled={isBusy}
          >
            Pointer
          </button>
          <button
            className={`button ghost tiny${timelineTool === "razor" ? " active" : ""}`}
            type="button"
            onClick={() => onSetTimelineTool("razor")}
            disabled={isBusy}
          >
            Razor
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={onDeletePiece}
            disabled={isBusy || !hasSelectedTimelineItemId}
          >
            Delete Piece
          </button>
        </div>
      </div>
    </>
  );
}

export default PreviewStage;
