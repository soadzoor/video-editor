import type { ExportFormat, ExportMode, ExportStage } from "../../../ffmpeg/export";
import { EXPORT_FORMAT_OPTIONS } from "../model/constants";
import type { CropRect } from "../model/types";

interface LargestClipResolution {
  area: number;
  width: number;
  height: number;
}

export interface ExportDockProps {
  isBusy: boolean;
  exportFormat: ExportFormat;
  exportFpsInput: string;
  exportWidthInput: string;
  exportHeightInput: string;
  exportSupportsVideo: boolean;
  exportSupportsAudio: boolean;
  largestClipResolution: LargestClipResolution;
  advancedExportOpen: boolean;
  disableVideoToggle: boolean;
  disableAudioToggle: boolean;
  effectiveIncludeVideo: boolean;
  effectiveIncludeAudio: boolean;
  exportVideoBitrateInput: string;
  exportAudioBitrateInput: string;
  autoResolutionLabel: string;
  normalizedCropRect: CropRect;
  exportMode: ExportMode;
  isExporting: boolean;
  hasEditedSegments: boolean;
  exportStage: ExportStage | null;
  exportStatusMessage: string | null;
  exportProgress: number;
  exportProgressPercentText: string;
  exportFrameCountText: string | null;
  exportEtaText: string | null;
  onSetExportFormat: (value: ExportFormat) => void;
  onSetExportFpsInput: (value: string) => void;
  onSetExportWidthInput: (value: string) => void;
  onSetExportHeightInput: (value: string) => void;
  onUseLargestSource: () => void;
  onAutoWorkspace: () => void;
  onToggleAdvanced: () => void;
  onSetIncludeVideo: (value: boolean) => void;
  onSetIncludeAudio: (value: boolean) => void;
  onSetExportVideoBitrateInput: (value: string) => void;
  onSetExportAudioBitrateInput: (value: string) => void;
  onSetExportMode: (mode: ExportMode) => void;
  onExport: () => void;
  exportStageLabel: (stage: ExportStage) => string;
}

function ExportDock({
  isBusy,
  exportFormat,
  exportFpsInput,
  exportWidthInput,
  exportHeightInput,
  exportSupportsVideo,
  exportSupportsAudio,
  largestClipResolution,
  advancedExportOpen,
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
  onSetExportFormat,
  onSetExportFpsInput,
  onSetExportWidthInput,
  onSetExportHeightInput,
  onUseLargestSource,
  onAutoWorkspace,
  onToggleAdvanced,
  onSetIncludeVideo,
  onSetIncludeAudio,
  onSetExportVideoBitrateInput,
  onSetExportAudioBitrateInput,
  onSetExportMode,
  onExport,
  exportStageLabel
}: ExportDockProps) {
  return (
    <>
      <div className="export-settings">
        <p className="export-settings-title">Export Settings</p>
        <div className="export-settings-grid">
          <label>
            Format
            <select
              className="time-input export-format-select"
              value={exportFormat}
              onChange={(event) => onSetExportFormat(event.target.value as ExportFormat)}
              disabled={isBusy}
            >
              {EXPORT_FORMAT_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            FPS
            <input
              className="time-input"
              type="number"
              min={1}
              max={120}
              step={1}
              placeholder="Auto"
              value={exportFpsInput}
              onChange={(event) => onSetExportFpsInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>

          <label>
            Workspace Width
            <input
              className="time-input"
              type="number"
              min={2}
              step={1}
              placeholder="Auto"
              value={exportWidthInput}
              onChange={(event) => onSetExportWidthInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>

          <label>
            Workspace Height
            <input
              className="time-input"
              type="number"
              min={2}
              step={1}
              placeholder="Auto"
              value={exportHeightInput}
              onChange={(event) => onSetExportHeightInput(event.target.value)}
              disabled={isBusy || !exportSupportsVideo}
            />
          </label>
        </div>

        <div className="export-settings-actions">
          <button
            className="button ghost tiny"
            type="button"
            onClick={onUseLargestSource}
            disabled={isBusy || largestClipResolution.area <= 0 || !exportSupportsVideo}
          >
            Use Largest Source
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={onAutoWorkspace}
            disabled={isBusy || !exportSupportsVideo}
          >
            Auto Workspace
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={onToggleAdvanced}
            disabled={isBusy}
          >
            {advancedExportOpen ? "Hide Advanced" : "Show Advanced"}
          </button>
        </div>

        {advancedExportOpen && (
          <div className="export-advanced">
            <p className="export-settings-subtitle">Advanced</p>
            <div className="toggle-row">
              <label className={`toggle-item${disableVideoToggle ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={effectiveIncludeVideo}
                  onChange={(event) => onSetIncludeVideo(event.target.checked)}
                  disabled={disableVideoToggle}
                />
                Include Video
              </label>
              <label className={`toggle-item${disableAudioToggle ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={effectiveIncludeAudio}
                  onChange={(event) => onSetIncludeAudio(event.target.checked)}
                  disabled={disableAudioToggle}
                />
                Include Audio
              </label>
            </div>
            <div className="export-settings-grid export-advanced-grid">
              <label>
                Video Bitrate (kbps)
                <input
                  className="time-input"
                  type="number"
                  min={100}
                  max={200000}
                  step={1}
                  placeholder="Auto"
                  value={exportVideoBitrateInput}
                  onChange={(event) => onSetExportVideoBitrateInput(event.target.value)}
                  disabled={isBusy || !effectiveIncludeVideo}
                />
              </label>
              <label>
                Audio Bitrate (kbps)
                <input
                  className="time-input"
                  type="number"
                  min={8}
                  max={3200}
                  step={1}
                  placeholder="Auto"
                  value={exportAudioBitrateInput}
                  onChange={(event) => onSetExportAudioBitrateInput(event.target.value)}
                  disabled={isBusy || !effectiveIncludeAudio}
                />
              </label>
            </div>
            <p className="hint">Leave bitrate empty to use codec defaults.</p>
          </div>
        )}

        <p className="hint">
          Workspace auto uses the largest source clip ({autoResolutionLabel}). FPS auto keeps source timing.
        </p>
        {exportSupportsVideo && (
          <p className="hint">
            Crop coordinates use workspace pixels. Enabled crop outputs {normalizedCropRect.width} x{" "}
            {normalizedCropRect.height}.
          </p>
        )}
        {!exportSupportsVideo && (
          <p className="hint">
            This format is audio-only. Workspace, crop, and FPS settings are ignored.
          </p>
        )}
        {!exportSupportsAudio && <p className="hint">This format does not support audio.</p>}
      </div>

      <div className="export-row">
        <div className="export-mode">
          <button
            className={`button ghost tiny${exportMode === "fit" ? " active" : ""}`}
            type="button"
            onClick={() => onSetExportMode("fit")}
            disabled={isBusy || !exportSupportsVideo}
          >
            Fit Canvas
          </button>
          <button
            className={`button ghost tiny${exportMode === "fast" ? " active" : ""}`}
            type="button"
            onClick={() => onSetExportMode("fast")}
            disabled={isBusy || !exportSupportsVideo}
          >
            Fast Copy
          </button>
        </div>

        <button
          className="button primary"
          type="button"
          onClick={onExport}
          disabled={isBusy || !hasEditedSegments}
        >
          {isExporting ? "Exporting..." : "Export Edited Video"}
        </button>
      </div>

      <p className="hint">
        {!exportSupportsVideo
          ? "Audio-only formats ignore workspace and crop settings."
          : exportMode === "fit"
            ? "Fit Canvas keeps a consistent workspace frame."
            : "Fast Copy is only available when no workspace, crop, transform, FPS, or speed changes are applied."}
      </p>

      {(isExporting || exportStage) && (
        <div className="progress-block">
          <p className="progress-label">
            {exportStatusMessage ?? (exportStage ? exportStageLabel(exportStage) : "Working...")}
          </p>
          <div className="progress-bar">
            <span
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, exportProgress)) * 100)}%`
              }}
            />
          </div>
          <p className="progress-meta">
            {exportProgressPercentText}
            {exportFrameCountText ? ` · ${exportFrameCountText}` : ""}
            {exportEtaText ? ` · ${exportEtaText}` : ""}
          </p>
        </div>
      )}
    </>
  );
}

export default ExportDock;
