import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type ConcatStage =
  | "loading-core"
  | "preparing-inputs"
  | "merging-fast"
  | "merging-reencode"
  | "finalizing";

export interface ConcatenateOptions {
  onStageChange?: (stage: ConcatStage, message: string) => void;
  onProgress?: (value: number) => void;
}

function extensionFromName(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!/^[a-z0-9]+$/.test(extension)) {
    return "mp4";
  }
  return extension;
}

export async function concatenateVideos(
  files: File[],
  options: ConcatenateOptions = {}
): Promise<Blob> {
  if (files.length < 2) {
    throw new Error("Add at least 2 videos before concatenating.");
  }

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();

  const runId = `concat-${Date.now().toString(36)}`;
  const inputPaths: string[] = [];
  const inputListPath = `${runId}-inputs.txt`;
  const outputPath = `${runId}-merged.mp4`;

  const progressListener = ({ progress }: { progress: number }) => {
    const normalized = Math.min(1, Math.max(0, progress));
    options.onProgress?.(normalized);
  };

  ffmpeg.on("progress", progressListener);

  try {
    options.onStageChange?.("preparing-inputs", "Preparing source files...");

    for (const [index, file] of files.entries()) {
      const extension = extensionFromName(file.name);
      const inputPath = `${runId}-input-${index}.${extension}`;
      inputPaths.push(inputPath);
      await ffmpeg.writeFile(inputPath, await fetchFile(file));
    }

    const concatList = inputPaths.map((path) => `file '${path}'`).join("\n");
    await ffmpeg.writeFile(inputListPath, concatList);

    options.onStageChange?.("merging-fast", "Concatenating (stream copy)...");

    let exitCode = await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      inputListPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath
    ]);

    if (exitCode !== 0) {
      options.onStageChange?.(
        "merging-reencode",
        "Fast concat failed, retrying with re-encode..."
      );
      options.onProgress?.(0);

      exitCode = await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        inputListPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outputPath
      ]);

      if (exitCode !== 0) {
        throw new Error(
          "Concatenation failed. Source files may be incompatible or corrupted."
        );
      }
    }

    options.onStageChange?.("finalizing", "Finalizing output...");
    options.onProgress?.(1);

    const outputData = await ffmpeg.readFile(outputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("FFmpeg returned unexpected output data.");
    }

    const standardBuffer = new Uint8Array(outputData.byteLength);
    standardBuffer.set(outputData);
    return new Blob([standardBuffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressListener);
    const pathsToDelete = [...inputPaths, inputListPath, outputPath];
    await Promise.all(pathsToDelete.map((path) => ffmpeg.deleteFile(path).catch(() => false)));
  }
}
