import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type EditStage =
  | "loading-core"
  | "preparing-input"
  | "processing-fast"
  | "processing-reencode"
  | "finalizing";

export interface EditOptions {
  onStageChange?: (stage: EditStage, message: string) => void;
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

export async function trimVideo(
  file: File,
  trimStartSec: number,
  trimEndSec: number,
  options: EditOptions = {}
): Promise<Blob> {
  if (trimEndSec <= trimStartSec) {
    throw new Error("Trim end must be greater than trim start.");
  }

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();

  const runId = `trim-${Date.now().toString(36)}`;
  const extension = sanitizeExtension(file.name);
  const inputPath = `${runId}-input.${extension}`;
  const outputPath = `${runId}-output.mp4`;
  const trimDurationSec = trimEndSec - trimStartSec;

  let progressRangeStart = 0;
  let progressRangeEnd = 1;
  const progressListener = ({ progress }: { progress: number }) => {
    const normalized = Math.min(1, Math.max(0, progress));
    const mapped =
      progressRangeStart + normalized * (progressRangeEnd - progressRangeStart);
    options.onProgress?.(mapped);
  };
  ffmpeg.on("progress", progressListener);

  try {
    options.onStageChange?.("preparing-input", "Preparing source file...");
    await ffmpeg.writeFile(inputPath, await fetchFile(file));

    options.onStageChange?.("processing-fast", "Trimming (stream copy)...");
    progressRangeStart = 0;
    progressRangeEnd = 1;
    let exitCode = await ffmpeg.exec([
      "-ss",
      toFfmpegSeconds(trimStartSec),
      "-t",
      toFfmpegSeconds(trimDurationSec),
      "-i",
      inputPath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath
    ]);

    if (exitCode !== 0) {
      options.onStageChange?.("processing-reencode", "Retrying trim with re-encode...");
      progressRangeStart = 0;
      progressRangeEnd = 1;
      exitCode = await ffmpeg.exec([
        "-ss",
        toFfmpegSeconds(trimStartSec),
        "-t",
        toFfmpegSeconds(trimDurationSec),
        "-i",
        inputPath,
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
        "-movflags",
        "+faststart",
        outputPath
      ]);

      if (exitCode !== 0) {
        throw new Error("Trim failed. Source file may be incompatible.");
      }
    }

    options.onStageChange?.("finalizing", "Finalizing trimmed output...");
    options.onProgress?.(1);

    const outputData = await ffmpeg.readFile(outputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected FFmpeg output format.");
    }
    return toBlob(outputData);
  } finally {
    ffmpeg.off("progress", progressListener);
    await cleanupFiles(ffmpeg, [inputPath, outputPath]);
  }
}

export async function cutVideoSection(
  file: File,
  cutStartSec: number,
  cutEndSec: number,
  totalDurationSec: number,
  options: EditOptions = {}
): Promise<Blob> {
  if (cutEndSec <= cutStartSec) {
    throw new Error("Cut end must be greater than cut start.");
  }

  if (cutStartSec <= 0.001 && cutEndSec >= totalDurationSec - 0.001) {
    throw new Error("Cannot remove the entire clip.");
  }

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();

  const runId = `cut-${Date.now().toString(36)}`;
  const extension = sanitizeExtension(file.name);
  const inputPath = `${runId}-input.${extension}`;
  const segmentAPath = `${runId}-segment-a.mp4`;
  const segmentBPath = `${runId}-segment-b.mp4`;
  const listPath = `${runId}-list.txt`;
  const outputPath = `${runId}-output.mp4`;

  const keepHead = cutStartSec > 0.001;
  const keepTail = cutEndSec < totalDurationSec - 0.001;
  const tailDurationSec = Math.max(0, totalDurationSec - cutEndSec);

  let progressRangeStart = 0;
  let progressRangeEnd = 1;
  const progressListener = ({ progress }: { progress: number }) => {
    const normalized = Math.min(1, Math.max(0, progress));
    const mapped =
      progressRangeStart + normalized * (progressRangeEnd - progressRangeStart);
    options.onProgress?.(mapped);
  };
  ffmpeg.on("progress", progressListener);

  try {
    options.onStageChange?.("preparing-input", "Preparing source file...");
    await ffmpeg.writeFile(inputPath, await fetchFile(file));

    options.onStageChange?.("processing-fast", "Cutting section (stream copy)...");

    if (keepHead) {
      progressRangeStart = 0;
      progressRangeEnd = keepTail ? 0.35 : 0.7;
      const headExitCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-t",
        toFfmpegSeconds(cutStartSec),
        "-c",
        "copy",
        segmentAPath
      ]);
      if (headExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    }

    if (keepTail) {
      progressRangeStart = keepHead ? 0.35 : 0;
      progressRangeEnd = 0.7;
      const tailExitCode = await ffmpeg.exec([
        "-ss",
        toFfmpegSeconds(cutEndSec),
        "-t",
        toFfmpegSeconds(tailDurationSec),
        "-i",
        inputPath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        segmentBPath
      ]);
      if (tailExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    }

    const segmentPaths = [
      ...(keepHead ? [segmentAPath] : []),
      ...(keepTail ? [segmentBPath] : [])
    ];

    if (segmentPaths.length === 1) {
      progressRangeStart = 0.7;
      progressRangeEnd = 1;
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
        listPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );
      progressRangeStart = 0.7;
      progressRangeEnd = 1;
      const concatExitCode = await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
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

    options.onStageChange?.("finalizing", "Finalizing cut output...");
    options.onProgress?.(1);

    const outputData = await ffmpeg.readFile(outputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected FFmpeg output format.");
    }
    return toBlob(outputData);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "fast-path-failed") {
      throw error;
    }

    options.onStageChange?.(
      "processing-reencode",
      "Fast cut failed, retrying with re-encode..."
    );
    options.onProgress?.(0);
    await cleanupFiles(ffmpeg, [segmentAPath, segmentBPath, listPath, outputPath]);

    const segmentPaths = [
      ...(keepHead ? [segmentAPath] : []),
      ...(keepTail ? [segmentBPath] : [])
    ];

    if (keepHead) {
      progressRangeStart = 0;
      progressRangeEnd = keepTail ? 0.35 : 0.7;
      const headExitCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-t",
        toFfmpegSeconds(cutStartSec),
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
        segmentAPath
      ]);
      if (headExitCode !== 0) {
        throw new Error("Cut failed while encoding first segment.");
      }
    }

    if (keepTail) {
      progressRangeStart = keepHead ? 0.35 : 0;
      progressRangeEnd = 0.7;
      const tailExitCode = await ffmpeg.exec([
        "-ss",
        toFfmpegSeconds(cutEndSec),
        "-t",
        toFfmpegSeconds(tailDurationSec),
        "-i",
        inputPath,
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
        segmentBPath
      ]);
      if (tailExitCode !== 0) {
        throw new Error("Cut failed while encoding second segment.");
      }
    }

    if (segmentPaths.length === 1) {
      progressRangeStart = 0.7;
      progressRangeEnd = 1;
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
        throw new Error("Cut failed while finalizing output.");
      }
    } else {
      await ffmpeg.writeFile(
        listPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );
      progressRangeStart = 0.7;
      progressRangeEnd = 1;
      const concatExitCode = await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ]);
      if (concatExitCode !== 0) {
        throw new Error("Cut failed while concatenating segments.");
      }
    }

    options.onStageChange?.("finalizing", "Finalizing cut output...");
    options.onProgress?.(1);

    const outputData = await ffmpeg.readFile(outputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected FFmpeg output format.");
    }
    return toBlob(outputData);
  } finally {
    ffmpeg.off("progress", progressListener);
    await cleanupFiles(ffmpeg, [inputPath, segmentAPath, segmentBPath, listPath, outputPath]);
  }
}
