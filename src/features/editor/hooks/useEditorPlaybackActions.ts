import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TimelinePreviewEngine } from "../../../preview-engine";
import { SEGMENT_END_EPSILON } from "../model/constants";
import { clamp } from "../model/formatters";
import { findSegmentIndex } from "../model/timeline";
import type { EditedSegment } from "../model/types";

export interface UseEditorPlaybackActionsParams {
  previewTimelineSegments: EditedSegment[];
  previewDurationSec: number;
  timelineDurationSec: number;
  frameReadoutFps: number;
  isPlaying: boolean;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  isPlayingRef: MutableRefObject<boolean>;
  togglePlayPauseRef: MutableRefObject<() => void>;
  stepPreviewFrameRef: MutableRefObject<(direction: -1 | 1) => void>;
  pendingFrameStepCountRef: MutableRefObject<number>;
  isApplyingFrameStepRef: MutableRefObject<boolean>;
  setPreviewPositionSec: Dispatch<SetStateAction<number>>;
  setCurrentSegmentIndex: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useEditorPlaybackActions({
  previewTimelineSegments,
  previewDurationSec,
  timelineDurationSec,
  frameReadoutFps,
  isPlaying,
  previewEngineRef,
  isPlayingRef,
  togglePlayPauseRef,
  stepPreviewFrameRef,
  pendingFrameStepCountRef,
  isApplyingFrameStepRef,
  setPreviewPositionSec,
  setCurrentSegmentIndex,
  setIsPlaying,
  setError
}: UseEditorPlaybackActionsParams) {
  function seekToPreviewPosition(targetSec: number, autoPlay: boolean): void {
    if (previewTimelineSegments.length === 0) {
      return;
    }

    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const clamped = clamp(targetSec, 0, upperBound);
    const nextIndex = findSegmentIndex(previewTimelineSegments, clamped);
    if (nextIndex < 0) {
      return;
    }

    setPreviewPositionSec(clamped);
    setCurrentSegmentIndex(nextIndex);

    const engine = previewEngineRef.current;
    if (!engine) {
      return;
    }

    if (!autoPlay && isPlayingRef.current) {
      engine.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    }

    engine.seek(clamped);
    if (autoPlay) {
      void engine.play().catch(() => {
        setError("Unable to start playback. Interact with the page and try again.");
      });
    }
  }

  function seekToTimelinePosition(rawPositionSec: number, autoPlay: boolean): void {
    if (previewTimelineSegments.length === 0 || timelineDurationSec <= 0) {
      return;
    }

    const boundedRaw = clamp(rawPositionSec, 0, timelineDurationSec);
    seekToPreviewPosition(boundedRaw, autoPlay);
  }

  function startFrameStepDrain(): void {
    if (isApplyingFrameStepRef.current) {
      return;
    }

    isApplyingFrameStepRef.current = true;
    void (async () => {
      try {
        while (pendingFrameStepCountRef.current !== 0) {
          const engine = previewEngineRef.current;
          if (!engine || previewTimelineSegments.length === 0) {
            pendingFrameStepCountRef.current = 0;
            break;
          }

          const nextDirection: -1 | 1 = pendingFrameStepCountRef.current > 0 ? 1 : -1;
          pendingFrameStepCountRef.current -= nextDirection;

          if (isPlayingRef.current) {
            engine.pause();
            isPlayingRef.current = false;
            setIsPlaying(false);
          }

          const stepFps = Math.max(1, frameReadoutFps);
          const upperBound = Math.max(0, previewDurationSec - 0.0001);
          const maxFrame = Math.max(0, Math.floor(upperBound * stepFps));
          const currentSec = clamp(engine.getPositionSec(), 0, upperBound);
          const currentFrame = clamp(Math.floor(currentSec * stepFps), 0, maxFrame);
          const targetFrame = clamp(currentFrame + nextDirection, 0, maxFrame);
          if (targetFrame === currentFrame) {
            continue;
          }

          const targetSec = clamp(targetFrame / stepFps + 0.25 / stepFps, 0, upperBound);
          await engine.seekAndRender(targetSec);

          const boundedNext = clamp(engine.getPositionSec(), 0, upperBound);
          const nextIndex = findSegmentIndex(previewTimelineSegments, boundedNext);
          if (nextIndex < 0) {
            continue;
          }

          setPreviewPositionSec(boundedNext);
          setCurrentSegmentIndex(nextIndex);
        }
      } finally {
        isApplyingFrameStepRef.current = false;
        if (pendingFrameStepCountRef.current !== 0) {
          startFrameStepDrain();
        }
      }
    })();
  }

  function stepPreviewFrame(direction: -1 | 1): void {
    if (previewTimelineSegments.length === 0) {
      return;
    }

    pendingFrameStepCountRef.current += direction;
    startFrameStepDrain();
  }

  async function togglePlayPause(): Promise<void> {
    const engine = previewEngineRef.current;
    if (!engine || previewTimelineSegments.length === 0) {
      return;
    }

    if (!isPlaying) {
      const currentPosition = engine.getPositionSec();
      if (currentPosition >= previewDurationSec - SEGMENT_END_EPSILON) {
        seekToPreviewPosition(0, false);
      }

      try {
        await engine.play();
      } catch {
        setError("Unable to start playback. Interact with the page and try again.");
      }
      return;
    }

    engine.pause();
    setIsPlaying(false);
  }

  togglePlayPauseRef.current = () => {
    void togglePlayPause();
  };
  stepPreviewFrameRef.current = stepPreviewFrame;

  return {
    seekToPreviewPosition,
    seekToTimelinePosition,
    startFrameStepDrain,
    stepPreviewFrame,
    togglePlayPause
  };
}
