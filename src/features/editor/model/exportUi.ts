import type { ExportStage } from "../../../ffmpeg/export";

export function exportStageLabel(stage: ExportStage): string {
  switch (stage) {
    case "loading-core":
      return "Loading FFmpeg core...";
    case "preparing-inputs":
      return "Preparing source files...";
    case "processing-fast":
      return "Building edited timeline...";
    case "processing-reencode":
      return "Re-encoding timeline segments...";
    case "finalizing":
      return "Finalizing export...";
  }
}
