import { MIN_CROP_SIZE_PX } from "../model/constants";
import type { CropRect, InspectorOpenState } from "../model/types";

export interface CropInspectorPanelProps {
  isBusy: boolean;
  clipsLength: number;
  exportSupportsVideo: boolean;
  cropEnabled: boolean;
  cropLockAspect: boolean;
  normalizedCropRect: CropRect;
  inspectorOpenState: InspectorOpenState;
  onSetInspectorOpenState: (updater: (previous: InspectorOpenState) => InspectorOpenState) => void;
  onSetCropEnabled: (enabled: boolean) => void;
  onResetCropRect: () => void;
  onSetCropLockAspect: (enabled: boolean) => void;
  onSetCropAspectRatioToCurrent: () => void;
  onSetCropField: (field: "x" | "y" | "width" | "height", value: string) => void;
}

function CropInspectorPanel({
  isBusy,
  clipsLength,
  exportSupportsVideo,
  cropEnabled,
  cropLockAspect,
  normalizedCropRect,
  inspectorOpenState,
  onSetInspectorOpenState,
  onSetCropEnabled,
  onResetCropRect,
  onSetCropLockAspect,
  onSetCropAspectRatioToCurrent,
  onSetCropField
}: CropInspectorPanelProps) {
  return (
    <section className="inspector-section">
      <button
        className="inspector-section-toggle"
        type="button"
        onClick={() =>
          onSetInspectorOpenState((previous) => ({
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
              <label className={`toggle-item${clipsLength === 0 ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={cropEnabled}
                  onChange={(event) => onSetCropEnabled(event.target.checked)}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
                />
                Enable Crop
              </label>
              <button
                className="button ghost tiny"
                type="button"
                onClick={onResetCropRect}
                disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
              >
                Reset Crop
              </button>
            </div>
            <div className="crop-controls-row">
              <label className={`toggle-item${clipsLength === 0 ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={cropLockAspect}
                  onChange={(event) => {
                    const nextChecked = event.target.checked;
                    if (nextChecked && normalizedCropRect.height > 0) {
                      onSetCropAspectRatioToCurrent();
                    }
                    onSetCropLockAspect(nextChecked);
                  }}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
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
                  onChange={(event) => onSetCropField("x", event.target.value)}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
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
                  onChange={(event) => onSetCropField("y", event.target.value)}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
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
                  onChange={(event) => onSetCropField("width", event.target.value)}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
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
                  onChange={(event) => onSetCropField("height", event.target.value)}
                  disabled={isBusy || clipsLength === 0 || !exportSupportsVideo}
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
}

export default CropInspectorPanel;
