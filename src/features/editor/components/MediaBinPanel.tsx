import { formatDuration, formatFileSize } from "../model/formatters";
import type { SourceClip } from "../model/types";

export interface MediaBinPanelProps {
  clips: SourceClip[];
  isBusy: boolean;
  isDragging: boolean;
  isIngesting: boolean;
  totalSourceDurationSec: number;
  onImport: () => void;
  onClear: () => void;
  onRemoveClip: (clipId: string) => void;
}

function MediaBinPanel({
  clips,
  isBusy,
  isDragging,
  isIngesting,
  totalSourceDurationSec,
  onImport,
  onClear,
  onRemoveClip
}: MediaBinPanelProps) {
  return (
    <>
      <div className="panel-header">
        <p className="panel-title">Media Bin</p>
        <div className="panel-header-actions">
          <button
            className="button secondary tiny"
            type="button"
            onClick={onImport}
            disabled={isBusy}
          >
            {isIngesting ? "Loading..." : "Import"}
          </button>
          <button
            className="button ghost tiny"
            type="button"
            onClick={onClear}
            disabled={clips.length === 0 || isBusy}
          >
            Clear
          </button>
        </div>
      </div>

      <div className={`media-dropzone ${isDragging ? "dragging" : ""}`}>
        <p className="dropzone-title">Drop videos here</p>
        <p className="dropzone-subtitle">Multiple files are concatenated by timeline order.</p>
      </div>

      <div className="media-metrics">
        <span className="metric-chip">Clips {clips.length}</span>
        <span className="metric-chip">Source {formatDuration(totalSourceDurationSec)}</span>
      </div>

      {clips.length === 0 ? (
        <p className="queue-empty">No clips yet.</p>
      ) : (
        <ul className="queue-list">
          {clips.map((clip, index) => (
            <li
              key={clip.id}
              className="queue-item"
            >
              <div className="queue-select">
                <span className="queue-order">{index + 1}</span>
                <span className="queue-name">{clip.file.name}</span>
                <span className="queue-size">
                  {formatDuration(clip.duration)} · {formatFileSize(clip.file.size)}
                </span>
              </div>
              <button
                className="button ghost tiny"
                type="button"
                onClick={() => onRemoveClip(clip.id)}
                disabled={isBusy}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default MediaBinPanel;
