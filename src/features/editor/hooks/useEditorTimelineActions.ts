import type {
  Dispatch,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction
} from "react";
import type { TimelinePreviewEngine } from "../../../preview-engine";
import { MIN_EDIT_GAP_SEC } from "../model/constants";
import { clamp, makeId } from "../model/formatters";
import { moveTimelineItem, snapTimelineValueToTargets } from "../model/timeline";
import type {
  EditedSegment,
  PlayheadDragState,
  TimelineDisplayItem,
  TimelineItem,
  TimelineTool,
  TrimWindowDragState
} from "../model/types";

export interface UseEditorTimelineActionsParams {
  isBusy: boolean;
  isPlaying: boolean;
  timelineTool: TimelineTool;
  timelineDurationSec: number;
  timelineDisplayItems: TimelineDisplayItem[];
  previewTimelineSegments: EditedSegment[];
  trimStartSec: number;
  trimEndSec: number;
  selectedTimelineItemId: string | null;
  draggingTimelineItemId: string | null;
  trimRangeShellRef: MutableRefObject<HTMLDivElement | null>;
  trimWindowDragRef: MutableRefObject<TrimWindowDragState | null>;
  playheadDragRef: MutableRefObject<PlayheadDragState | null>;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  setTimelineItems: Dispatch<SetStateAction<TimelineItem[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setIsDraggingTrimEdge: Dispatch<SetStateAction<boolean>>;
  setActiveTrimEdge: Dispatch<SetStateAction<"start" | "end" | null>>;
  setIsDraggingPlayhead: Dispatch<SetStateAction<boolean>>;
  setDraggingTimelineItemId: Dispatch<SetStateAction<string | null>>;
  seekToTimelinePosition: (rawPositionSec: number, autoPlay: boolean) => void;
}

export function useEditorTimelineActions({
  isBusy,
  isPlaying,
  timelineTool,
  timelineDurationSec,
  timelineDisplayItems,
  previewTimelineSegments,
  trimStartSec,
  trimEndSec,
  selectedTimelineItemId,
  draggingTimelineItemId,
  trimRangeShellRef,
  trimWindowDragRef,
  playheadDragRef,
  previewEngineRef,
  setTimelineItems,
  setError,
  setIsPlaying,
  setIsDraggingTrimEdge,
  setActiveTrimEdge,
  setIsDraggingPlayhead,
  setDraggingTimelineItemId,
  seekToTimelinePosition
}: UseEditorTimelineActionsParams) {
  function splitTimelineAt(rawPositionSec: number): void {
    if (timelineDisplayItems.length === 0 || timelineDurationSec <= 0) {
      return;
    }

    const bounded = clamp(rawPositionSec, 0, timelineDurationSec);
    const target = timelineDisplayItems.find(
      (item) =>
        bounded > item.timelineStart + MIN_EDIT_GAP_SEC &&
        bounded < item.timelineEnd - MIN_EDIT_GAP_SEC
    );

    if (!target) {
      setError("Place the razor inside a timeline piece (not on an edge).");
      return;
    }

    const splitSource = target.sourceStart + (bounded - target.timelineStart) * target.speed;
    const leftId = makeId();
    const rightId = makeId();

    setTimelineItems((previous) => {
      const index = previous.findIndex((item) => item.id === target.id);
      if (index < 0) {
        return previous;
      }

      const leftPiece: TimelineItem = {
        id: leftId,
        sourceClipId: target.sourceClipId,
        sourceStart: target.sourceStart,
        sourceEnd: splitSource,
        speed: target.speed,
        scale: target.scale,
        panX: target.panX,
        panY: target.panY
      };
      const rightPiece: TimelineItem = {
        id: rightId,
        sourceClipId: target.sourceClipId,
        sourceStart: splitSource,
        sourceEnd: target.sourceEnd,
        speed: target.speed,
        scale: target.scale,
        panX: target.panX,
        panY: target.panY
      };

      return [
        ...previous.slice(0, index),
        leftPiece,
        rightPiece,
        ...previous.slice(index + 1)
      ];
    });

    setError(null);
  }

  function handleTimelineSegmentClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    item: TimelineDisplayItem
  ): void {
    if (isBusy) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawPosition = item.timelineStart + item.duration * ratio;

    if (timelineTool === "razor") {
      splitTimelineAt(rawPosition);
      return;
    }

    seekToTimelinePosition(rawPosition, isPlaying);
  }

  function handleTrimEdgePointerDown(
    event: ReactPointerEvent<HTMLSpanElement>,
    mode: "start" | "end"
  ): void {
    if (event.button !== 0 || isBusy || timelineDurationSec <= 0 || trimEndSec <= trimStartSec) {
      return;
    }

    const rail = trimRangeShellRef.current;
    if (!rail) {
      return;
    }

    const railRect = rail.getBoundingClientRect();
    if (railRect.width <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    trimWindowDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      railWidthPx: railRect.width,
      initialStartSec: trimStartSec,
      initialEndSec: trimEndSec,
      mode
    };
    setActiveTrimEdge(mode);
    setIsDraggingTrimEdge(true);
  }

  function handlePlayheadPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (
      event.button !== 0 ||
      isBusy ||
      timelineDurationSec <= 0 ||
      previewTimelineSegments.length === 0
    ) {
      return;
    }

    const rail = trimRangeShellRef.current;
    if (!rail) {
      return;
    }

    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    previewEngineRef.current?.pause();
    setIsPlaying(false);

    playheadDragRef.current = {
      pointerId: event.pointerId,
      railLeftPx: rect.left,
      railWidthPx: rect.width
    };
    setIsDraggingPlayhead(true);

    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawPosition = ratio * timelineDurationSec;
    const nextPosition = event.altKey
      ? rawPosition
      : snapTimelineValueToTargets(
          rawPosition,
          [trimStartSec, trimEndSec],
          rect.width,
          timelineDurationSec
        );
    seekToTimelinePosition(nextPosition, false);
  }

  function handleTimelineItemDragStart(
    event: ReactDragEvent<HTMLButtonElement>,
    itemId: string
  ): void {
    if (isBusy || timelineTool !== "select") {
      event.preventDefault();
      return;
    }

    setDraggingTimelineItemId(itemId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function handleTimelineItemDragOver(event: ReactDragEvent<HTMLButtonElement>): void {
    if (!draggingTimelineItemId || isBusy || timelineTool !== "select") {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleTimelineItemDrop(
    event: ReactDragEvent<HTMLButtonElement>,
    targetId: string
  ): void {
    if (!draggingTimelineItemId || isBusy || timelineTool !== "select") {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;

    setTimelineItems((previous) =>
      moveTimelineItem(previous, draggingTimelineItemId, targetId, placeAfter)
    );
    setDraggingTimelineItemId(null);
  }

  function handleTimelineItemDragEnd(): void {
    setDraggingTimelineItemId(null);
  }

  function removeSelectedTimelinePiece(): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    setTimelineItems((previous) => previous.filter((item) => item.id !== selectedTimelineItemId));
  }

  return {
    splitTimelineAt,
    handleTimelineSegmentClick,
    handleTrimEdgePointerDown,
    handlePlayheadPointerDown,
    handleTimelineItemDragStart,
    handleTimelineItemDragOver,
    handleTimelineItemDrop,
    handleTimelineItemDragEnd,
    removeSelectedTimelinePiece
  };
}
