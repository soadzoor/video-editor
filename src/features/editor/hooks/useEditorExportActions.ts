import type { Dispatch, SetStateAction } from "react";
import {
  exportEditedTimeline,
  type ExportFormat,
  type ExportMode,
  type ExportStage
} from "../../../ffmpeg/export";
import { parsePositiveIntegerInput } from "../model/formatters";
import type { CropRect, EditedSegment, SourceClip } from "../model/types";

interface ExportFrameProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
}

export interface UseEditorExportActionsParams {
  editedSegments: EditedSegment[];
  isBusy: boolean;
  effectiveIncludeVideo: boolean;
  effectiveIncludeAudio: boolean;
  exportWidthInput: string;
  exportHeightInput: string;
  exportFpsInput: string;
  exportVideoBitrateInput: string;
  exportAudioBitrateInput: string;
  exportMode: ExportMode;
  exportFormat: ExportFormat;
  exportFormatConfig: { extension: string };
  workspaceWidth: number;
  workspaceHeight: number;
  cropEnabled: boolean;
  normalizedCropRect: CropRect;
  clipById: Map<string, SourceClip>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsExporting: Dispatch<SetStateAction<boolean>>;
  setExportStage: Dispatch<SetStateAction<ExportStage | null>>;
  setExportStatusMessage: Dispatch<SetStateAction<string | null>>;
  setExportProgress: Dispatch<SetStateAction<number>>;
  setExportFrameProgress: Dispatch<SetStateAction<ExportFrameProgress | null>>;
  setExportStartedAtMs: Dispatch<SetStateAction<number | null>>;
  setExportNowMs: Dispatch<SetStateAction<number>>;
}

export function useEditorExportActions({
  editedSegments,
  isBusy,
  effectiveIncludeVideo,
  effectiveIncludeAudio,
  exportWidthInput,
  exportHeightInput,
  exportFpsInput,
  exportVideoBitrateInput,
  exportAudioBitrateInput,
  exportMode,
  exportFormat,
  exportFormatConfig,
  workspaceWidth,
  workspaceHeight,
  cropEnabled,
  normalizedCropRect,
  clipById,
  setError,
  setIsExporting,
  setExportStage,
  setExportStatusMessage,
  setExportProgress,
  setExportFrameProgress,
  setExportStartedAtMs,
  setExportNowMs
}: UseEditorExportActionsParams) {
  async function handleExport(): Promise<void> {
    if (editedSegments.length === 0 || isBusy) {
      return;
    }

    const includeVideo = effectiveIncludeVideo;
    const includeAudio = effectiveIncludeAudio;
    if (!includeVideo && !includeAudio) {
      setError("Enable video or audio before exporting.");
      return;
    }

    const widthValue = exportWidthInput.trim();
    const heightValue = exportHeightInput.trim();
    const fpsValue = exportFpsInput.trim();
    const videoBitrateValue = exportVideoBitrateInput.trim();
    const audioBitrateValue = exportAudioBitrateInput.trim();

    let exportFps: number | undefined;
    let exportVideoBitrateKbps: number | undefined;
    let exportAudioBitrateKbps: number | undefined;

    if (includeVideo) {
      if ((widthValue === "") !== (heightValue === "")) {
        setError("Set both workspace width and height, or leave both empty.");
        return;
      }

      if (widthValue !== "" && heightValue !== "") {
        const parsedWidth = parsePositiveIntegerInput(widthValue);
        const parsedHeight = parsePositiveIntegerInput(heightValue);
        if (!parsedWidth || !parsedHeight || parsedWidth < 2 || parsedHeight < 2) {
          setError("Workspace resolution must use positive integers.");
          return;
        }
      }

      if (fpsValue !== "") {
        const parsedFps = Number(fpsValue);
        if (!Number.isFinite(parsedFps) || parsedFps < 1 || parsedFps > 120) {
          setError("FPS must be between 1 and 120.");
          return;
        }
        exportFps = Math.round(parsedFps);
      }
    }

    if (includeVideo && videoBitrateValue !== "") {
      const parsedVideoBitrate = parsePositiveIntegerInput(videoBitrateValue);
      if (!parsedVideoBitrate || parsedVideoBitrate < 100 || parsedVideoBitrate > 200_000) {
        setError("Video bitrate must be between 100 and 200000 kbps.");
        return;
      }
      exportVideoBitrateKbps = parsedVideoBitrate;
    }

    if (includeAudio && audioBitrateValue !== "") {
      const parsedAudioBitrate = parsePositiveIntegerInput(audioBitrateValue);
      if (!parsedAudioBitrate || parsedAudioBitrate < 8 || parsedAudioBitrate > 3_200) {
        setError("Audio bitrate must be between 8 and 3200 kbps.");
        return;
      }
      exportAudioBitrateKbps = parsedAudioBitrate;
    }

    setIsExporting(true);
    setExportStage("loading-core");
    setExportStatusMessage("Loading FFmpeg core...");
    setExportProgress(0);
    setExportFrameProgress(null);
    setExportStartedAtMs(Date.now());
    setExportNowMs(Date.now());
    setError(null);

    try {
      const exportSegments = editedSegments.map((segment) => {
        const clip = clipById.get(segment.clipId);
        if (!clip) {
          throw new Error("A source clip referenced by the timeline could not be found.");
        }

        return {
          file: clip.file,
          startSec: segment.sourceStart,
          endSec: segment.sourceEnd,
          speed: segment.speed,
          scale: segment.scale,
          panX: segment.panX,
          panY: segment.panY,
          width: clip.width,
          height: clip.height
        };
      });

      const blob = await exportEditedTimeline(exportSegments, {
        mode: exportMode,
        format: exportFormat,
        workspaceWidth: includeVideo ? workspaceWidth : undefined,
        workspaceHeight: includeVideo ? workspaceHeight : undefined,
        fps: exportFps,
        crop: {
          enabled: cropEnabled,
          x: normalizedCropRect.x,
          y: normalizedCropRect.y,
          width: normalizedCropRect.width,
          height: normalizedCropRect.height
        },
        includeVideo,
        includeAudio,
        videoBitrateKbps: exportVideoBitrateKbps,
        audioBitrateKbps: exportAudioBitrateKbps,
        onStageChange: (stage, message) => {
          setExportStage(stage);
          setExportStatusMessage(message);
        },
        onProgress: (value) => setExportProgress(value),
        onFrameProgress: (currentFrame, totalFrames, percent) => {
          setExportFrameProgress({ currentFrame, totalFrames, percent });
        }
      });

      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `edited-video.${exportFormatConfig.extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
      }, 1000);

      setExportProgress(1);
      setExportStage("finalizing");
      setExportStatusMessage("Finalizing export...");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Export failed unexpectedly.";
      setError(message);
    } finally {
      setIsExporting(false);
      setExportStartedAtMs(null);
    }
  }

  return {
    handleExport
  };
}
