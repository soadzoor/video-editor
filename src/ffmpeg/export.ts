import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type ExportStage =
  | "loading-core"
  | "preparing-inputs"
  | "processing-fast"
  | "processing-reencode"
  | "finalizing";

export interface ExportSegment {
  file: File;
  startSec: number;
  endSec: number;
}

export interface ExportOptions {
  onStageChange?: (stage: ExportStage, message: string) => void;
  onProgress?: (value: number) => void;
}

function sanitizeExtension(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!/^[a-z0-9]+$/.test(extension)) {
    return "mp4";
  }
  return extension;
}

function toFfmpegSeconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function toBlob(data: Uint8Array): Blob {
  const standardBuffer = new Uint8Array(data.byteLength);
  standardBuffer.set(data);
  return new Blob([standardBuffer], { type: "video/mp4" });
}

async function cleanupFiles(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>, paths: string[]) {
  await Promise.all(paths.map((path) => ffmpeg.deleteFile(path).catch(() => false)));
}

export async function exportEditedTimeline(
  segments: ExportSegment[],
  options: ExportOptions = {}
): Promise<Blob> {
  if (segments.length === 0) {
    throw new Error("No segments available to export.");
  }

  const sanitizedSegments = segments
    .map((segment) => ({
      ...segment,
      startSec: Math.max(0, segment.startSec),
      endSec: Math.max(0, segment.endSec)
    }))
    .filter((segment) => segment.endSec - segment.startSec > 0.01);

  if (sanitizedSegments.length === 0) {
    throw new Error("All timeline segments are empty.");
  }

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();

  const runId = `export-${Date.now().toString(36)}`;
  const sourcePaths: string[] = [];
  const segmentPaths: string[] = [];
  const inputListPath = `${runId}-segments.txt`;
  const outputPath = `${runId}-output.mp4`;

  const fileKeyToPath = new Map<string, string>();

  try {
    options.onStageChange?.("preparing-inputs", "Writing source files...");

    for (const [index, segment] of sanitizedSegments.entries()) {
      const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
      if (!fileKeyToPath.has(key)) {
        const extension = sanitizeExtension(segment.file.name);
        const sourcePath = `${runId}-src-${fileKeyToPath.size}.${extension}`;
        await ffmpeg.writeFile(sourcePath, await fetchFile(segment.file));
        fileKeyToPath.set(key, sourcePath);
        sourcePaths.push(sourcePath);
      }

      const segmentPath = `${runId}-seg-${index}.mp4`;
      segmentPaths.push(segmentPath);
    }

    const segmentTotal = sanitizedSegments.length;

    options.onStageChange?.("processing-fast", "Extracting timeline segments...");
    for (const [index, segment] of sanitizedSegments.entries()) {
      const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
      const sourcePath = fileKeyToPath.get(key);
      if (!sourcePath) {
        throw new Error("Source path not found during export.");
      }

      const duration = segment.endSec - segment.startSec;
      const segmentPath = segmentPaths[index];
      const exitCode = await ffmpeg.exec([
        "-ss",
        toFfmpegSeconds(segment.startSec),
        "-t",
        toFfmpegSeconds(duration),
        "-i",
        sourcePath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        segmentPath
      ]);

      if (exitCode !== 0) {
        throw new Error("fast-path-failed");
      }

      options.onProgress?.(0.1 + ((index + 1) / segmentTotal) * 0.6);
    }

    if (segmentPaths.length === 1) {
      const cloneExitCode = await ffmpeg.exec([
        "-i",
        segmentPaths[0],
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ]);
      if (cloneExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    } else {
      await ffmpeg.writeFile(
        inputListPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );
      const concatExitCode = await ffmpeg.exec([
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
      if (concatExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    }
  } catch (error) {
    const fastPathFailed = error instanceof Error && error.message === "fast-path-failed";
    if (!fastPathFailed) {
      throw error;
    }

    options.onStageChange?.(
      "processing-reencode",
      "Fast export failed, retrying with re-encode..."
    );
    options.onProgress?.(0.1);
    await cleanupFiles(ffmpeg, [...segmentPaths, inputListPath, outputPath]);

    const segmentTotal = sanitizedSegments.length;
    for (const [index, segment] of sanitizedSegments.entries()) {
      const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
      const sourcePath = fileKeyToPath.get(key);
      if (!sourcePath) {
        throw new Error("Source path not found during re-encode export.");
      }

      const duration = segment.endSec - segment.startSec;
      const segmentPath = segmentPaths[index];
      const exitCode = await ffmpeg.exec([
        "-ss",
        toFfmpegSeconds(segment.startSec),
        "-t",
        toFfmpegSeconds(duration),
        "-i",
        sourcePath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
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
        segmentPath
      ]);

      if (exitCode !== 0) {
        throw new Error("Export failed while re-encoding timeline segment.");
      }

      options.onProgress?.(0.1 + ((index + 1) / segmentTotal) * 0.6);
    }

    if (segmentPaths.length === 1) {
      const cloneExitCode = await ffmpeg.exec([
        "-i",
        segmentPaths[0],
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ]);
      if (cloneExitCode !== 0) {
        throw new Error("Export failed while finalizing single segment.");
      }
    } else {
      await ffmpeg.writeFile(
        inputListPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );

      let concatExitCode = await ffmpeg.exec([
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

      if (concatExitCode !== 0) {
        concatExitCode = await ffmpeg.exec([
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
      }

      if (concatExitCode !== 0) {
        throw new Error("Export failed while concatenating segments.");
      }
    }
  }

  try {
    options.onStageChange?.("finalizing", "Finalizing exported video...");
    options.onProgress?.(0.95);
    const outputData = await ffmpeg.readFile(outputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected export output format.");
    }
    options.onProgress?.(1);
    return toBlob(outputData);
  } finally {
    await cleanupFiles(ffmpeg, [...sourcePaths, ...segmentPaths, inputListPath, outputPath]);
  }
}
