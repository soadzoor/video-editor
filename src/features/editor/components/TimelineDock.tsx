import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject
} from "react";
import { formatSecondsLabel, formatSpeedLabel } from "../model/formatters";
import type { SourceClip, TimelineDisplayItem, TimelineTool } from "../model/types";

export interface TimelineDockProps {
  timelineDurationSec: number;
  timelineTool: TimelineTool;
  trimRangeShellRef: RefObject<HTMLDivElement | null>;
  trimStartPercent: number;
  trimRightPercent: number;
  timelineDisplayItems: TimelineDisplayItem[];
  clipById: Map<string, SourceClip>;
  selectedTimelineItemId: string | null;
  draggingTimelineItemId: string | null;
  isBusy: boolean;
  isDraggingPlayhead: boolean;
  playheadPercent: number;
  isDraggingTrimEdge: boolean;
  activeTrimEdge: "start" | "end" | null;
  trimStartSec: number;
  trimEndSec: number;
  onTimelineSegmentClick: (event: ReactMouseEvent<HTMLButtonElement>, item: TimelineDisplayItem) => void;
  onTimelineItemDragStart: (event: ReactDragEvent<HTMLButtonElement>, itemId: string) => void;
  onTimelineItemDragOver: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onTimelineItemDrop: (event: ReactDragEvent<HTMLButtonElement>, targetId: string) => void;
  onTimelineItemDragEnd: () => void;
  onPlayheadPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTrimEdgePointerDown: (event: ReactPointerEvent<HTMLSpanElement>, mode: "start" | "end") => void;
}

function TimelineDock({
  timelineDurationSec,
  timelineTool,
  trimRangeShellRef,
  trimStartPercent,
  trimRightPercent,
  timelineDisplayItems,
  clipById,
  selectedTimelineItemId,
  draggingTimelineItemId,
  isBusy,
  isDraggingPlayhead,
  playheadPercent,
  isDraggingTrimEdge,
  activeTrimEdge,
  trimStartSec,
  trimEndSec,
  onTimelineSegmentClick,
  onTimelineItemDragStart,
  onTimelineItemDragOver,
  onTimelineItemDrop,
  onTimelineItemDragEnd,
  onPlayheadPointerDown,
  onTrimEdgePointerDown
}: TimelineDockProps) {
  if (timelineDurationSec <= 0) {
    return <p className="queue-empty">Load clips to edit the timeline.</p>;
  }

  return (
    <div className="timeline-visual">
      <div
        className="timeline-track-shell"
        ref={trimRangeShellRef}
      >
        <div
          className="timeline-mask timeline-mask-start"
          style={{ width: `${trimStartPercent}%` }}
        />
        <div
          className="timeline-mask timeline-mask-end"
          style={{ width: `${trimRightPercent}%` }}
        />

        <div className={`timeline-track${timelineTool === "razor" ? " razor" : ""}`}>
          {timelineDisplayItems.map((item) => {
            const width = timelineDurationSec > 0 ? (item.duration / timelineDurationSec) * 100 : 0;
            const clip = clipById.get(item.sourceClipId);
            const clipFileName = clip?.file.name ?? "Unknown file";
            const isSelected = item.id === selectedTimelineItemId;
            const isDraggingItem = item.id === draggingTimelineItemId;

            return (
              <button
                key={item.id}
                className={`timeline-segment${isSelected ? " selected" : ""}${
                  isDraggingItem ? " dragging" : ""
                }`}
                style={{ width: `${width}%` }}
                type="button"
                onClick={(event) => onTimelineSegmentClick(event, item)}
                onDragStart={(event) => onTimelineItemDragStart(event, item.id)}
                onDragOver={onTimelineItemDragOver}
                onDrop={(event) => onTimelineItemDrop(event, item.id)}
                onDragEnd={onTimelineItemDragEnd}
                draggable={!isBusy && timelineTool === "select"}
                disabled={isBusy}
                title={`File: ${clipFileName} · ${formatSecondsLabel(
                  item.sourceStart
                )} -> ${formatSecondsLabel(item.sourceEnd)} · ${formatSpeedLabel(item.speed)}x`}
              >
                <span className="timeline-segment-label">{clipFileName}</span>
              </button>
            );
          })}
        </div>

        <div
          className={`timeline-playhead${isDraggingPlayhead ? " dragging" : ""}`}
          style={{ left: `${playheadPercent}%` }}
          onPointerDown={onPlayheadPointerDown}
          title="Drag playhead"
        >
          <span className="timeline-playhead-hitbox" aria-hidden="true" />
          <span className="timeline-playhead-handle" aria-hidden="true" />
        </div>

        <div
          className={`trim-range-window${isDraggingTrimEdge ? " dragging" : ""}${
            activeTrimEdge === "start"
              ? " dragging-start"
              : activeTrimEdge === "end"
                ? " dragging-end"
                : ""
          }`}
          style={{
            left: `${trimStartPercent}%`,
            right: `${trimRightPercent}%`
          }}
        >
          <span
            className="trim-window-edge trim-window-edge-start"
            onPointerDown={(event) => onTrimEdgePointerDown(event, "start")}
            title="Drag trim start edge"
          />
          <span
            className="trim-window-edge trim-window-edge-end"
            onPointerDown={(event) => onTrimEdgePointerDown(event, "end")}
            title="Drag trim end edge"
          />
        </div>
      </div>

      <div className="trim-rail-values">
        <span>In {formatSecondsLabel(trimStartSec)}</span>
        <span>Out {formatSecondsLabel(trimEndSec)}</span>
      </div>
      <p className="hint">
        Click pieces to seek. Use Razor to split. Drag pieces left/right in Pointer mode to reorder.
      </p>
    </div>
  );
}

export default TimelineDock;
