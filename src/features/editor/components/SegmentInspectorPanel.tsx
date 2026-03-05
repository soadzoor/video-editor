import {
  MAX_PIECE_SCALE,
  MAX_SEGMENT_SPEED,
  MIN_PIECE_SCALE,
  MIN_PIECE_SCALE_LOG,
  MIN_SEGMENT_SPEED,
  MIN_SEGMENT_SPEED_LOG
} from "../model/constants";
import {
  formatScaleLabel,
  formatSecondsLabel,
  formatSpeedLabel,
  logSliderValueToScale,
  logSliderValueToSpeed
} from "../model/formatters";
import type { InspectorOpenState, SourceClip, TimelineDisplayItem } from "../model/types";

interface SetTransformInput {
  scale?: number;
  panX?: number;
  panY?: number;
}

export interface SegmentInspectorPanelProps {
  selectedTimelineItem: TimelineDisplayItem | null;
  clipById: Map<string, SourceClip>;
  inspectorOpenState: InspectorOpenState;
  onSetInspectorOpenState: (updater: (previous: InspectorOpenState) => InspectorOpenState) => void;
  isBusy: boolean;
  selectedSpeedInput: string;
  selectedDurationMinutesInput: string;
  selectedDurationSecondsInput: string;
  selectedDurationMillisecondsInput: string;
  selectedScaleInput: string;
  selectedPanXInput: string;
  selectedPanYInput: string;
  selectedSpeedSliderValue: number;
  selectedScaleSliderValue: number;
  onHandleSelectedSpeedInputChange: (value: string) => void;
  onCommitSelectedSpeedInput: () => void;
  onSetSelectedTimelineSpeed: (value: number) => void;
  onHandleSelectedDurationInputChange: (
    part: "minutes" | "seconds" | "milliseconds",
    value: string
  ) => void;
  onCommitSelectedDurationInput: () => void;
  onHandleSelectedScaleInputChange: (value: string) => void;
  onCommitSelectedScaleInput: () => void;
  onSetSelectedTimelineTransform: (next: SetTransformInput) => void;
  onHandleSelectedPanInputChange: (axis: "x" | "y", value: string) => void;
  onCommitSelectedPanInput: (axis: "x" | "y") => void;
  onFillSelectedPieceToCrop: () => void;
  onResetSelectedTransform: () => void;
}

function SegmentInspectorPanel({
  selectedTimelineItem,
  clipById,
  inspectorOpenState,
  onSetInspectorOpenState,
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
  onHandleSelectedSpeedInputChange,
  onCommitSelectedSpeedInput,
  onSetSelectedTimelineSpeed,
  onHandleSelectedDurationInputChange,
  onCommitSelectedDurationInput,
  onHandleSelectedScaleInputChange,
  onCommitSelectedScaleInput,
  onSetSelectedTimelineTransform,
  onHandleSelectedPanInputChange,
  onCommitSelectedPanInput,
  onFillSelectedPieceToCrop,
  onResetSelectedTransform
}: SegmentInspectorPanelProps) {
  if (!selectedTimelineItem) {
    return <p className="queue-empty">Select a timeline piece to edit speed and transform.</p>;
  }

  const sourceClipName = clipById.get(selectedTimelineItem.sourceClipId)?.file.name ?? "Unknown";
  const sourceRangeLabel = `${formatSecondsLabel(selectedTimelineItem.sourceStart)} - ${formatSecondsLabel(selectedTimelineItem.sourceEnd)}`;

  return (
    <section className="inspector-section">
      <button
        className="inspector-section-toggle"
        type="button"
        onClick={() =>
          onSetInspectorOpenState((previous) => ({
            ...previous,
            segment: !previous.segment
          }))
        }
      >
        <span>Selected Segment</span>
        <span>{inspectorOpenState.segment ? "Hide" : "Show"}</span>
      </button>

      {inspectorOpenState.segment && (
        <div className="inspector-section-body">
          <p className="hint segment-source-hint">
            <span className="segment-source-name" title={sourceClipName}>
              {sourceClipName}
            </span>
            <span className="segment-source-range"> · {sourceRangeLabel}</span>
          </p>

          <div className="inspector-subsection">
            <button
              className="inspector-subsection-toggle"
              type="button"
              onClick={() =>
                onSetInspectorOpenState((previous) => ({
                  ...previous,
                  speed: !previous.speed
                }))
              }
            >
              <span>Speed + Duration</span>
              <span>{inspectorOpenState.speed ? "Hide" : "Show"}</span>
            </button>

            {inspectorOpenState.speed && (
              <div className="inspector-subsection-body">
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
                      onChange={(event) => onHandleSelectedSpeedInputChange(event.target.value)}
                      onBlur={onCommitSelectedSpeedInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedSpeedInput();
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
                  max={Math.log10(MAX_SEGMENT_SPEED)}
                  step={0.01}
                  value={selectedSpeedSliderValue}
                  onChange={(event) => onSetSelectedTimelineSpeed(logSliderValueToSpeed(Number(event.target.value)))}
                  disabled={isBusy}
                  aria-label="Selected piece speed"
                />
                <div className="piece-speed-scale">
                  <span>{formatSpeedLabel(MIN_SEGMENT_SPEED)}x</span>
                  <span>1x</span>
                  <span>{formatSpeedLabel(MAX_SEGMENT_SPEED)}x</span>
                </div>
                <div className="duration-input-grid">
                  <label>
                    Min
                    <input
                      className="time-input"
                      type="number"
                      min={0}
                      step={1}
                      value={selectedDurationMinutesInput}
                      onChange={(event) =>
                        onHandleSelectedDurationInputChange("minutes", event.target.value)
                      }
                      onBlur={onCommitSelectedDurationInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedDurationInput();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece duration minutes"
                    />
                  </label>
                  <label>
                    Sec
                    <input
                      className="time-input"
                      type="number"
                      min={0}
                      step={1}
                      value={selectedDurationSecondsInput}
                      onChange={(event) =>
                        onHandleSelectedDurationInputChange("seconds", event.target.value)
                      }
                      onBlur={onCommitSelectedDurationInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedDurationInput();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece duration seconds"
                    />
                  </label>
                  <label>
                    Ms
                    <input
                      className="time-input"
                      type="number"
                      min={0}
                      step={1}
                      value={selectedDurationMillisecondsInput}
                      onChange={(event) =>
                        onHandleSelectedDurationInputChange("milliseconds", event.target.value)
                      }
                      onBlur={onCommitSelectedDurationInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedDurationInput();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece duration milliseconds"
                    />
                  </label>
                </div>
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
                      onClick={() => onSetSelectedTimelineSpeed(preset)}
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
            )}
          </div>

          <div className="inspector-subsection">
            <button
              className="inspector-subsection-toggle"
              type="button"
              onClick={() =>
                onSetInspectorOpenState((previous) => ({
                  ...previous,
                  transform: !previous.transform
                }))
              }
            >
              <span>Transform</span>
              <span>{inspectorOpenState.transform ? "Hide" : "Show"}</span>
            </button>

            {inspectorOpenState.transform && (
              <div className="inspector-subsection-body">
                <div className="piece-speed-header">
                  <span>Scale</span>
                  <strong>{formatScaleLabel(selectedTimelineItem.scale)}x</strong>
                </div>
                <label className="piece-speed-input-row">
                  <span>Scale</span>
                  <div className="piece-speed-input-wrap">
                    <input
                      className="time-input piece-speed-input"
                      type="number"
                      min={MIN_PIECE_SCALE}
                      max={MAX_PIECE_SCALE}
                      step="any"
                      value={selectedScaleInput}
                      onChange={(event) => onHandleSelectedScaleInputChange(event.target.value)}
                      onBlur={onCommitSelectedScaleInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedScaleInput();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece scale input"
                    />
                    <span>x</span>
                  </div>
                </label>
                <input
                  className="piece-speed-slider"
                  type="range"
                  min={MIN_PIECE_SCALE_LOG}
                  max={Math.log10(MAX_PIECE_SCALE)}
                  step={0.01}
                  value={selectedScaleSliderValue}
                  onChange={(event) =>
                    onSetSelectedTimelineTransform({
                      scale: logSliderValueToScale(Number(event.target.value))
                    })
                  }
                  disabled={isBusy}
                  aria-label="Selected piece scale"
                />
                <div className="piece-speed-scale">
                  <span>{formatScaleLabel(MIN_PIECE_SCALE)}x</span>
                  <span>1x</span>
                  <span>{formatScaleLabel(MAX_PIECE_SCALE)}x</span>
                </div>
                <label className="piece-speed-input-row">
                  <span>Pan X</span>
                  <div className="piece-speed-input-wrap">
                    <input
                      className="time-input piece-speed-input"
                      type="number"
                      step="any"
                      value={selectedPanXInput}
                      onChange={(event) => onHandleSelectedPanInputChange("x", event.target.value)}
                      onBlur={() => onCommitSelectedPanInput("x")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedPanInput("x");
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece pan X input"
                    />
                    <span>px</span>
                  </div>
                </label>
                <label className="piece-speed-input-row">
                  <span>Pan Y</span>
                  <div className="piece-speed-input-wrap">
                    <input
                      className="time-input piece-speed-input"
                      type="number"
                      step="any"
                      value={selectedPanYInput}
                      onChange={(event) => onHandleSelectedPanInputChange("y", event.target.value)}
                      onBlur={() => onCommitSelectedPanInput("y")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitSelectedPanInput("y");
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      disabled={isBusy}
                      aria-label="Selected piece pan Y input"
                    />
                    <span>px</span>
                  </div>
                </label>
                <div className="piece-speed-presets">
                  <button
                    className="button ghost tiny"
                    type="button"
                    onClick={onFillSelectedPieceToCrop}
                    disabled={isBusy}
                  >
                    Fill Crop
                  </button>
                  <button
                    className="button ghost tiny"
                    type="button"
                    onClick={onResetSelectedTransform}
                    disabled={isBusy}
                  >
                    Reset Transform
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default SegmentInspectorPanel;
