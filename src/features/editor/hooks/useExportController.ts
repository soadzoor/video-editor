import { useState } from "react";
import type { ExportFormat, ExportMode, ExportStage } from "../../../ffmpeg/export";

export function useExportController() {
  const [isExporting, setIsExporting] = useState(false);
  const [exportStage, setExportStage] = useState<ExportStage | null>(null);
  const [exportStatusMessage, setExportStatusMessage] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportFrameProgress, setExportFrameProgress] = useState<{
    currentFrame: number;
    totalFrames: number;
    percent: number;
  } | null>(null);
  const [exportStartedAtMs, setExportStartedAtMs] = useState<number | null>(null);
  const [exportNowMs, setExportNowMs] = useState(() => Date.now());
  const [exportMode, setExportMode] = useState<ExportMode>("fast");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [exportWidthInput, setExportWidthInput] = useState("");
  const [exportHeightInput, setExportHeightInput] = useState("");
  const [exportFpsInput, setExportFpsInput] = useState("");
  const [includeVideoInExport, setIncludeVideoInExport] = useState(true);
  const [includeAudioInExport, setIncludeAudioInExport] = useState(true);
  const [exportVideoBitrateInput, setExportVideoBitrateInput] = useState("");
  const [exportAudioBitrateInput, setExportAudioBitrateInput] = useState("");

  return {
    isExporting,
    setIsExporting,
    exportStage,
    setExportStage,
    exportStatusMessage,
    setExportStatusMessage,
    exportProgress,
    setExportProgress,
    exportFrameProgress,
    setExportFrameProgress,
    exportStartedAtMs,
    setExportStartedAtMs,
    exportNowMs,
    setExportNowMs,
    exportMode,
    setExportMode,
    exportFormat,
    setExportFormat,
    exportWidthInput,
    setExportWidthInput,
    exportHeightInput,
    setExportHeightInput,
    exportFpsInput,
    setExportFpsInput,
    includeVideoInExport,
    setIncludeVideoInExport,
    includeAudioInExport,
    setIncludeAudioInExport,
    exportVideoBitrateInput,
    setExportVideoBitrateInput,
    exportAudioBitrateInput,
    setExportAudioBitrateInput
  };
}
