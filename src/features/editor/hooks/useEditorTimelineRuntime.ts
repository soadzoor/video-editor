import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import { MIN_EDIT_GAP_SEC, TRIM_SNAP_STEP_SEC } from "../model/constants";
import { clamp, nearlyEqual, normalizeTimeValue } from "../model/formatters";
import { snapTimelineValueToTargets } from "../model/timeline";
import type { PlayheadDragState, TrimWindowDragState } from "../model/types";

export interface UseEditorTimelineRuntimeParams {
  timelineDurationSec: number;
  trimStartSec: number;
  trimEndSec: number;
  playheadRawSec: number;
  isBusy: boolean;
  isDraggingTrimEdge: boolean;
  trimWindowDragRef: MutableRefObject<TrimWindowDragState | null>;
  setIsDraggingTrimEdge: Dispatch<SetStateAction<boolean>>;
  setActiveTrimEdge: Dispatch<SetStateAction<"start" | "end" | null>>;
  isDraggingPlayhead: boolean;
  playheadDragRef: MutableRefObject<PlayheadDragState | null>;
  setIsDraggingPlayhead: Dispatch<SetStateAction<boolean>>;
  seekToTimelinePosition: (rawPositionSec: number, autoPlay: boolean) => void;
  setTrimStartSec: Dispatch<SetStateAction<number>>;
  setTrimEndSec: Dispatch<SetStateAction<number>>;
  previousTimelineDurationRef: MutableRefObject<number>;
  skipTrimRescaleRef: MutableRefObject<boolean>;
}

export function useEditorTimelineRuntime({
  timelineDurationSec,
  trimStartSec,
  trimEndSec,
  playheadRawSec,
  isBusy,
  isDraggingTrimEdge,
  trimWindowDragRef,
  setIsDraggingTrimEdge,
  setActiveTrimEdge,
  isDraggingPlayhead,
  playheadDragRef,
  setIsDraggingPlayhead,
  seekToTimelinePosition,
  setTrimStartSec,
  setTrimEndSec,
  previousTimelineDurationRef,
  skipTrimRescaleRef
}: UseEditorTimelineRuntimeParams): void {
  const minTrimGapSec = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);

  function applyTrimStart(nextValueSec: number): void {
    const maxStart = Math.max(0, trimEndSec - minTrimGapSec);
    const snapThreshold = TRIM_SNAP_STEP_SEC * 1.5;
    let bounded = clamp(nextValueSec, 0, maxStart);

    if (bounded <= snapThreshold) {
      bounded = 0;
    } else if (maxStart - bounded <= snapThreshold) {
      bounded = maxStart;
    }

    bounded = normalizeTimeValue(bounded);
    setTrimStartSec((previous) => (nearlyEqual(previous, bounded) ? previous : bounded));
  }

  function applyTrimEnd(nextValueSec: number): void {
    const minEnd = Math.min(timelineDurationSec, trimStartSec + minTrimGapSec);
    const snapThreshold = TRIM_SNAP_STEP_SEC * 1.5;
    let bounded = clamp(nextValueSec, minEnd, timelineDurationSec);

    if (timelineDurationSec - bounded <= snapThreshold) {
      bounded = timelineDurationSec;
    } else if (bounded - minEnd <= snapThreshold) {
      bounded = minEnd;
    }

    bounded = normalizeTimeValue(bounded);
    setTrimEndSec((previous) => (nearlyEqual(previous, bounded) ? previous : bounded));
  }

  useEffect(() => {
    const previousDuration = previousTimelineDurationRef.current;
    previousTimelineDurationRef.current = timelineDurationSec;

    if (skipTrimRescaleRef.current) {
      skipTrimRescaleRef.current = false;
      return;
    }

    if (
      previousDuration <= 0 ||
      timelineDurationSec <= 0 ||
      nearlyEqual(previousDuration, timelineDurationSec)
    ) {
      return;
    }

    const startRatio = clamp(trimStartSec / previousDuration, 0, 1);
    const endRatio = clamp(trimEndSec / previousDuration, startRatio, 1);

    let nextStart = startRatio * timelineDurationSec;
    let nextEnd = endRatio * timelineDurationSec;

    const gap = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);
    if (nextEnd - nextStart < gap) {
      const center = (nextStart + nextEnd) / 2;
      nextStart = clamp(center - gap / 2, 0, Math.max(0, timelineDurationSec - gap));
      nextEnd = nextStart + gap;
    }

    if (!nearlyEqual(nextStart, trimStartSec)) {
      setTrimStartSec(nextStart);
    }
    if (!nearlyEqual(nextEnd, trimEndSec)) {
      setTrimEndSec(nextEnd);
    }
  }, [
    previousTimelineDurationRef,
    setTrimEndSec,
    setTrimStartSec,
    skipTrimRescaleRef,
    timelineDurationSec,
    trimEndSec,
    trimStartSec
  ]);

  useEffect(() => {
    if (timelineDurationSec <= 0) {
      if (!nearlyEqual(trimStartSec, 0)) {
        setTrimStartSec(0);
      }
      if (!nearlyEqual(trimEndSec, 0)) {
        setTrimEndSec(0);
      }
      return;
    }

    const gap = Math.min(MIN_EDIT_GAP_SEC, timelineDurationSec);
    const maxStart = Math.max(0, timelineDurationSec - gap);
    const boundedStart = clamp(trimStartSec, 0, maxStart);

    if (!nearlyEqual(boundedStart, trimStartSec)) {
      setTrimStartSec(boundedStart);
      return;
    }

    const minEnd = Math.min(timelineDurationSec, boundedStart + gap);
    const boundedEnd = clamp(trimEndSec, minEnd, timelineDurationSec);
    if (!nearlyEqual(boundedEnd, trimEndSec)) {
      setTrimEndSec(boundedEnd);
    }
  }, [setTrimEndSec, setTrimStartSec, timelineDurationSec, trimEndSec, trimStartSec]);

  useEffect(() => {
    if (!isDraggingTrimEdge) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = trimWindowDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      if (drag.railWidthPx <= 0 || timelineDurationSec <= 0) {
        return;
      }

      event.preventDefault();

      const deltaSec =
        ((event.clientX - drag.startClientX) / drag.railWidthPx) * timelineDurationSec;
      if (drag.mode === "start") {
        const nextRaw = drag.initialStartSec + deltaSec;
        const nextValue = event.altKey
          ? nextRaw
          : snapTimelineValueToTargets(
              nextRaw,
              [playheadRawSec],
              drag.railWidthPx,
              timelineDurationSec
            );
        applyTrimStart(nextValue);
      } else {
        const nextRaw = drag.initialEndSec + deltaSec;
        const nextValue = event.altKey
          ? nextRaw
          : snapTimelineValueToTargets(
              nextRaw,
              [playheadRawSec],
              drag.railWidthPx,
              timelineDurationSec
            );
        applyTrimEnd(nextValue);
      }
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = trimWindowDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }

      trimWindowDragRef.current = null;
      setIsDraggingTrimEdge(false);
      setActiveTrimEdge(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [
    isDraggingTrimEdge,
    playheadRawSec,
    setActiveTrimEdge,
    setIsDraggingTrimEdge,
    timelineDurationSec,
    trimWindowDragRef
  ]);

  useEffect(() => {
    if (!isDraggingTrimEdge) {
      return;
    }

    if (isBusy || timelineDurationSec <= 0) {
      trimWindowDragRef.current = null;
      setIsDraggingTrimEdge(false);
      setActiveTrimEdge(null);
    }
  }, [
    isBusy,
    isDraggingTrimEdge,
    setActiveTrimEdge,
    setIsDraggingTrimEdge,
    timelineDurationSec,
    trimWindowDragRef
  ]);

  useEffect(() => {
    if (!isDraggingPlayhead) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = playheadDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      if (drag.railWidthPx <= 0 || timelineDurationSec <= 0) {
        return;
      }

      event.preventDefault();
      const ratio = clamp((event.clientX - drag.railLeftPx) / drag.railWidthPx, 0, 1);
      const rawPosition = ratio * timelineDurationSec;
      const nextPosition = event.altKey
        ? rawPosition
        : snapTimelineValueToTargets(
            rawPosition,
            [trimStartSec, trimEndSec],
            drag.railWidthPx,
            timelineDurationSec
          );
      seekToTimelinePosition(nextPosition, false);
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = playheadDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }

      playheadDragRef.current = null;
      setIsDraggingPlayhead(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [
    isDraggingPlayhead,
    playheadDragRef,
    seekToTimelinePosition,
    setIsDraggingPlayhead,
    timelineDurationSec,
    trimEndSec,
    trimStartSec
  ]);

  useEffect(() => {
    if (!isDraggingPlayhead) {
      return;
    }

    if (isBusy || timelineDurationSec <= 0) {
      playheadDragRef.current = null;
      setIsDraggingPlayhead(false);
    }
  }, [isBusy, isDraggingPlayhead, playheadDragRef, setIsDraggingPlayhead, timelineDurationSec]);
}
