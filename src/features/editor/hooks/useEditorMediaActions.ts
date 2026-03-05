import type { ChangeEvent, Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ExportStage } from "../../../ffmpeg/export";
import type { TimelinePreviewEngine } from "../../../preview-engine";
import { makeId } from "../model/formatters";
import { loadVideoMetadata } from "../model/media";
import { timelineDurationFromItems } from "../model/timeline";
import type { CropRect, SourceClip, TimelineItem } from "../model/types";

interface ExportFrameProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
}

export interface UseEditorMediaActionsParams {
  clips: SourceClip[];
  timelineItems: TimelineItem[];
  setClips: Dispatch<SetStateAction<SourceClip[]>>;
  setTimelineItems: Dispatch<SetStateAction<TimelineItem[]>>;
  setIsIngesting: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setTrimStartSec: Dispatch<SetStateAction<number>>;
  setTrimEndSec: Dispatch<SetStateAction<number>>;
  setPreviewPositionSec: Dispatch<SetStateAction<number>>;
  setCurrentSegmentIndex: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  previewEngineRef: MutableRefObject<TimelinePreviewEngine | null>;
  skipTrimRescaleRef: MutableRefObject<boolean>;
  setExportProgress: Dispatch<SetStateAction<number>>;
  setExportFrameProgress: Dispatch<SetStateAction<ExportFrameProgress | null>>;
  setExportStartedAtMs: Dispatch<SetStateAction<number | null>>;
  setExportStage: Dispatch<SetStateAction<ExportStage | null>>;
  setExportStatusMessage: Dispatch<SetStateAction<string | null>>;
  setDraggingTimelineItemId: Dispatch<SetStateAction<string | null>>;
  setCropEnabled: Dispatch<SetStateAction<boolean>>;
  setCropRect: Dispatch<SetStateAction<CropRect>>;
  previousWorkspaceSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
}

export function useEditorMediaActions({
  clips,
  timelineItems,
  setClips,
  setTimelineItems,
  setIsIngesting,
  setError,
  setTrimStartSec,
  setTrimEndSec,
  setPreviewPositionSec,
  setCurrentSegmentIndex,
  setIsPlaying,
  previewEngineRef,
  skipTrimRescaleRef,
  setExportProgress,
  setExportFrameProgress,
  setExportStartedAtMs,
  setExportStage,
  setExportStatusMessage,
  setDraggingTimelineItemId,
  setCropEnabled,
  setCropRect,
  previousWorkspaceSizeRef,
  fileInputRef
}: UseEditorMediaActionsParams) {
  function resetTimelineWindow(durationSec: number): void {
    skipTrimRescaleRef.current = true;
    previewEngineRef.current?.pause();
    previewEngineRef.current?.seek(0);
    setTrimStartSec(0);
    setTrimEndSec(durationSec);
    setPreviewPositionSec(0);
    setCurrentSegmentIndex(0);
    setIsPlaying(false);
  }

  async function addVideos(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = Array.from(fileList).filter((file) => file.type.startsWith("video/"));
    if (files.length === 0) {
      setError("No valid video files were provided.");
      return;
    }

    setIsIngesting(true);
    setError(null);

    const nextClips: SourceClip[] = [];
    try {
      for (const file of files) {
        const url = URL.createObjectURL(file);
        try {
          const metadata = await loadVideoMetadata(url);
          if (metadata.duration <= 0) {
            throw new Error(`Could not read duration for \"${file.name}\".`);
          }

          nextClips.push({
            id: makeId(),
            file,
            url,
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height
          });
        } catch (metadataError) {
          URL.revokeObjectURL(url);
          throw metadataError;
        }
      }

      const appendedTimelineItems: TimelineItem[] = nextClips.map((clip) => ({
        id: makeId(),
        sourceClipId: clip.id,
        sourceStart: 0,
        sourceEnd: clip.duration,
        speed: 1,
        scale: 1,
        panX: 0,
        panY: 0
      }));

      const combinedClips = [...clips, ...nextClips];
      const combinedTimeline = [...timelineItems, ...appendedTimelineItems];

      setClips(combinedClips);
      setTimelineItems(combinedTimeline);
      resetTimelineWindow(timelineDurationFromItems(combinedTimeline));
    } catch (caughtError) {
      for (const clip of nextClips) {
        URL.revokeObjectURL(clip.url);
      }

      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to load one or more videos.";
      setError(message);
    } finally {
      setIsIngesting(false);
    }
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    await addVideos(event.target.files);
    event.target.value = "";
  }

  function removeClip(id: string): void {
    const clip = clips.find((item) => item.id === id);
    if (!clip) {
      return;
    }

    URL.revokeObjectURL(clip.url);

    const nextClips = clips.filter((item) => item.id !== id);
    const nextTimeline = timelineItems.filter((item) => item.sourceClipId !== id);

    setClips(nextClips);
    setTimelineItems(nextTimeline);
    resetTimelineWindow(timelineDurationFromItems(nextTimeline));
  }

  function clearQueue(): void {
    for (const clip of clips) {
      URL.revokeObjectURL(clip.url);
    }

    setClips([]);
    setTimelineItems([]);
    resetTimelineWindow(0);
    setError(null);
    setExportProgress(0);
    setExportFrameProgress(null);
    setExportStartedAtMs(null);
    setExportStage(null);
    setExportStatusMessage(null);
    setDraggingTimelineItemId(null);
    setCropEnabled(false);
    setCropRect({
      x: 0,
      y: 0,
      width: 1280,
      height: 720
    });
    previousWorkspaceSizeRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return {
    resetTimelineWindow,
    addVideos,
    handleFileInput,
    removeClip,
    clearQueue
  };
}
