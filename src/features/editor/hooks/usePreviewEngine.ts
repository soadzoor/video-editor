import { useRef, useState } from "react";
import { TimelinePreviewEngine } from "../../../preview-engine";
import type { EditedSegment } from "../model/types";

export function usePreviewEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewPositionSec, setPreviewPositionSec] = useState(0);
  const [, setCurrentSegmentIndex] = useState(0);
  const [isPreviewSupported] = useState(
    () => typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window
  );

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewSurfaceRef = useRef<HTMLDivElement>(null);
  const previewEngineRef = useRef<TimelinePreviewEngine | null>(null);
  const previewSegmentsRef = useRef<EditedSegment[]>([]);
  const isPlayingRef = useRef(false);
  const togglePlayPauseRef = useRef<() => void>(() => undefined);
  const stepPreviewFrameRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  const pendingFrameStepCountRef = useRef(0);
  const isApplyingFrameStepRef = useRef(false);

  return {
    isPlaying,
    setIsPlaying,
    previewPositionSec,
    setPreviewPositionSec,
    setCurrentSegmentIndex,
    isPreviewSupported,
    previewCanvasRef,
    previewSurfaceRef,
    previewEngineRef,
    previewSegmentsRef,
    isPlayingRef,
    togglePlayPauseRef,
    stepPreviewFrameRef,
    pendingFrameStepCountRef,
    isApplyingFrameStepRef
  };
}
