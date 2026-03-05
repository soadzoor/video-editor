import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  TimelinePreviewEngine,
  type PreviewClip,
  type PreviewSegment
} from "../../../preview-engine";
import { PREVIEW_UI_POSITION_STEP_SEC } from "../model/constants";
import { clamp, nearlyEqual } from "../model/formatters";
import { findSegmentIndex } from "../model/timeline";
import type { DockTab, EditedSegment, WorkspacePaneSizes } from "../model/types";

export interface UseEditorPreviewLifecycleParams {
  isPreviewSupported: boolean;
  previewCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  previewSegmentsRef: MutableRefObject<EditedSegment[]>;
  isPlayingRef: MutableRefObject<boolean>;
  setPreviewPositionSec: Dispatch<SetStateAction<number>>;
  setCurrentSegmentIndex: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  previewClips: PreviewClip[];
  previewSegments: PreviewSegment[];
  workspaceWidth: number;
  workspaceHeight: number;
  dockTab: DockTab;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  workspacePaneSizes: WorkspacePaneSizes;
  previewTimelineSegments: EditedSegment[];
  previewDurationSec: number;
  previewPositionSec: number;
}

export function useEditorPreviewLifecycle({
  isPreviewSupported,
  previewCanvasRef,
  previewEngineRef,
  previewSegmentsRef,
  isPlayingRef,
  setPreviewPositionSec,
  setCurrentSegmentIndex,
  setIsPlaying,
  setError,
  previewClips,
  previewSegments,
  workspaceWidth,
  workspaceHeight,
  dockTab,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  workspacePaneSizes,
  previewTimelineSegments,
  previewDurationSec,
  previewPositionSec
}: UseEditorPreviewLifecycleParams): void {
  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }

    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return;
    }

    const engine = new TimelinePreviewEngine(canvas, {
      onTimeUpdate: (timeSec) => {
        setPreviewPositionSec((previous) => {
          const minStep = isPlayingRef.current ? PREVIEW_UI_POSITION_STEP_SEC : 0.000001;
          if (Math.abs(previous - timeSec) < minStep) {
            return previous;
          }
          return timeSec;
        });

        const currentSegments = previewSegmentsRef.current;
        if (currentSegments.length === 0) {
          setCurrentSegmentIndex(0);
          return;
        }

        const upperBound = Math.max(0, currentSegments[currentSegments.length - 1].editedEnd - 0.0001);
        const bounded = clamp(timeSec, 0, upperBound);
        const nextIndex = Math.max(0, findSegmentIndex(currentSegments, bounded));
        setCurrentSegmentIndex((previous) => (previous === nextIndex ? previous : nextIndex));
      },
      onPlayStateChange: (playing) => {
        isPlayingRef.current = playing;
        setIsPlaying(playing);
      },
      onError: (message) => {
        setError(message);
      }
    });

    previewEngineRef.current = engine;

    return () => {
      engine.destroy();
      if (previewEngineRef.current === engine) {
        previewEngineRef.current = null;
      }
    };
  }, [
    isPlayingRef,
    isPreviewSupported,
    previewCanvasRef,
    previewEngineRef,
    previewSegmentsRef,
    setCurrentSegmentIndex,
    setError,
    setIsPlaying,
    setPreviewPositionSec
  ]);

  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }

    const engine = previewEngineRef.current;
    if (!engine) {
      return;
    }

    const currentPosition = engine.getPositionSec();
    void engine.setProject(previewClips, previewSegments, currentPosition, {
      width: workspaceWidth,
      height: workspaceHeight
    });
  }, [
    isPreviewSupported,
    previewClips,
    previewEngineRef,
    previewSegments,
    workspaceHeight,
    workspaceWidth
  ]);

  useEffect(() => {
    if (!isPreviewSupported) {
      return;
    }

    const engine = previewEngineRef.current;
    if (!engine || previewTimelineSegments.length === 0) {
      return;
    }

    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const bounded = clamp(engine.getPositionSec(), 0, upperBound);
    engine.seek(bounded);
  }, [
    dockTab,
    isLeftPanelCollapsed,
    isPreviewSupported,
    isRightPanelCollapsed,
    previewDurationSec,
    previewEngineRef,
    previewTimelineSegments.length,
    workspacePaneSizes.left,
    workspacePaneSizes.right
  ]);

  useEffect(() => {
    if (previewTimelineSegments.length === 0) {
      previewEngineRef.current?.pause();
      setCurrentSegmentIndex(0);
      setPreviewPositionSec(0);
      setIsPlaying(false);
      return;
    }

    const engine = previewEngineRef.current;
    const upperBound = Math.max(0, previewDurationSec - 0.0001);
    const currentPosition = engine?.getPositionSec() ?? previewPositionSec;
    const clampedPosition = clamp(currentPosition, 0, upperBound);
    const nextSegmentIndex = Math.max(0, findSegmentIndex(previewTimelineSegments, clampedPosition));

    engine?.pause();
    setIsPlaying(false);
    setPreviewPositionSec((previous) => (nearlyEqual(previous, clampedPosition) ? previous : clampedPosition));
    setCurrentSegmentIndex((previous) => (previous === nextSegmentIndex ? previous : nextSegmentIndex));
    engine?.seek(clampedPosition);
    // Intentionally driven by timeline structure only.
    // Depending on previewPositionSec here would pause playback on every frame tick.
  }, [previewDurationSec, previewTimelineSegments]);
}
