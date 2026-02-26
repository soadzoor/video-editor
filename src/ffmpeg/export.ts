import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type ExportStage =
  | "loading-core"
  | "preparing-inputs"
  | "processing-fast"
  | "processing-reencode"
  | "finalizing";

export type ExportMode = "fit" | "fast";
export type ExportFormat = "mp4" | "mov" | "avi" | "webm" | "mkv" | "gif";

interface ExportFormatConfig {
  extension: string;
  mimeType: string;
}

export interface ExportSegment {
  file: File;
  startSec: number;
  endSec: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  mode?: ExportMode;
  format?: ExportFormat;
  outputWidth?: number;
  outputHeight?: number;
  fps?: number;
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

function toEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function toBlob(data: Uint8Array, mimeType: string): Blob {
  const standardBuffer = new Uint8Array(data.byteLength);
  standardBuffer.set(data);
  return new Blob([standardBuffer], { type: mimeType });
}

function normalizeOptionalFps(value: number | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value as number);
  return Math.min(120, Math.max(1, rounded));
}

function getFormatConfig(format: ExportFormat): ExportFormatConfig {
  switch (format) {
    case "mov":
      return { extension: "mov", mimeType: "video/quicktime" };
    case "avi":
      return { extension: "avi", mimeType: "video/x-msvideo" };
    case "webm":
      return { extension: "webm", mimeType: "video/webm" };
    case "mkv":
      return { extension: "mkv", mimeType: "video/x-matroska" };
    case "gif":
      return { extension: "gif", mimeType: "image/gif" };
    default:
      return { extension: "mp4", mimeType: "video/mp4" };
  }
}

async function cleanupFiles(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>, paths: string[]) {
  await Promise.all(paths.map((path) => ffmpeg.deleteFile(path).catch(() => false)));
}

let ffmpegDebugListenerAttached = false;

function attachFfmpegDebugListener(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>): void {
  if (ffmpegDebugListenerAttached) {
    return;
  }

  ffmpegDebugListenerAttached = true;
  ffmpeg.on("log", (event: { type: string; message: string }) => {
    console.log(`[ffmpeg:${event.type}] ${event.message}`);
  });
}

async function execWithDebug(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  args: string[],
  label: string
): Promise<number> {
  console.log(`[ffmpeg.exec:${label}] ${args.join(" ")}`);
  const startedAt = performance.now();
  try {
    const exitCode = await ffmpeg.exec(args);
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log(`[ffmpeg.exit:${label}] code=${exitCode} elapsedMs=${elapsedMs}`);
    return exitCode;
  } catch (error) {
    console.error(`[ffmpeg.error:${label}]`, error);
    throw error;
  }
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
      endSec: Math.max(0, segment.endSec),
      width: Math.max(0, Math.round(segment.width)),
      height: Math.max(0, Math.round(segment.height))
    }))
    .filter((segment) => segment.endSec - segment.startSec > 0.01);

  if (sanitizedSegments.length === 0) {
    throw new Error("All timeline segments are empty.");
  }

  const largestSegment = sanitizedSegments.reduce<{
    area: number;
    width: number;
    height: number;
  }>(
    (largest, segment) => {
      const area = segment.width * segment.height;
      if (area > largest.area) {
        return { area, width: segment.width, height: segment.height };
      }
      return largest;
    },
    { area: 0, width: 0, height: 0 }
  );

  if (largestSegment.area <= 0) {
    throw new Error("Could not determine export resolution from source clips.");
  }

  const exportMode = options.mode ?? "fit";
  const exportFormat = options.format ?? "mp4";
  const formatConfig = getFormatConfig(exportFormat);
  const requestedWidth =
    Number.isFinite(options.outputWidth) && (options.outputWidth as number) > 0
      ? toEvenDimension(options.outputWidth as number)
      : null;
  const requestedHeight =
    Number.isFinite(options.outputHeight) && (options.outputHeight as number) > 0
      ? toEvenDimension(options.outputHeight as number)
      : null;
  const hasCustomResolution = requestedWidth !== null && requestedHeight !== null;
  const targetWidth = requestedWidth ?? toEvenDimension(largestSegment.width);
  const targetHeight = requestedHeight ?? toEvenDimension(largestSegment.height);
  const targetFps = normalizeOptionalFps(options.fps);
  const fitScaleFilter =
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const stretchScaleFilter = `scale=${targetWidth}:${targetHeight},setsar=1`;
  const hasResolutionMismatch = sanitizedSegments.some(
    (segment) => segment.width !== targetWidth || segment.height !== targetHeight
  );
  const shouldNormalize = exportMode === "fit" && hasResolutionMismatch;
  const shouldStretchResize = exportMode === "fast" && hasCustomResolution && hasResolutionMismatch;
  const shouldApplyFps = targetFps !== null;
  const canUseFastPath = !shouldNormalize && !shouldStretchResize && !shouldApplyFps;
  const baseFilters: string[] = [];
  if (shouldNormalize) {
    baseFilters.push(fitScaleFilter);
  } else if (shouldStretchResize) {
    baseFilters.push(stretchScaleFilter);
  }
  if (shouldApplyFps && targetFps !== null) {
    baseFilters.push(`fps=${targetFps}`);
  }
  const baseVideoFilter = baseFilters.length > 0 ? baseFilters.join(",") : null;
  const reencodePreset = baseVideoFilter ? "ultrafast" : "veryfast";
  const reencodeCrf = baseVideoFilter ? "28" : "23";
  const reencodeAudioBitrate = baseVideoFilter ? "96k" : "128k";

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();
  attachFfmpegDebugListener(ffmpeg);
  console.log("[export] config", {
    segmentCount: sanitizedSegments.length,
    exportMode,
    exportFormat,
    hasCustomResolution,
    hasResolutionMismatch,
    targetFps,
    targetWidth,
    targetHeight,
    canUseFastPath,
    shouldStretchResize,
    shouldNormalize,
    reencodePreset,
    reencodeCrf,
    reencodeAudioBitrate
  });

  const runId = `export-${Date.now().toString(36)}`;
  const sourcePaths: string[] = [];
  const segmentPaths: string[] = [];
  const tempPaths: string[] = [];
  const inputListPath = `${runId}-segments.txt`;
  const timelineOutputPath = `${runId}-timeline.mp4`;
  const finalOutputPath =
    exportFormat === "mp4" ? timelineOutputPath : `${runId}-output.${formatConfig.extension}`;

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

    if (!canUseFastPath) {
      throw new Error("fast-path-failed");
    }

    options.onStageChange?.("processing-fast", "Extracting timeline segments...");
    for (const [index, segment] of sanitizedSegments.entries()) {
      const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
      const sourcePath = fileKeyToPath.get(key);
      if (!sourcePath) {
        throw new Error("Source path not found during export.");
      }

      const duration = segment.endSec - segment.startSec;
      const segmentPath = segmentPaths[index];
      const exitCode = await execWithDebug(
        ffmpeg,
        [
        "-nostdin",
        "-y",
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
        ],
        `fast-segment-${index}`
      );

      if (exitCode !== 0) {
        throw new Error("fast-path-failed");
      }

      options.onProgress?.(0.1 + ((index + 1) / segmentTotal) * 0.6);
    }

    if (segmentPaths.length === 1) {
      const cloneExitCode = await execWithDebug(
        ffmpeg,
        [
          "-nostdin",
          "-y",
          "-i",
          segmentPaths[0],
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          timelineOutputPath
        ],
        "fast-finalize-single"
      );
      if (cloneExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    } else {
      await ffmpeg.writeFile(
        inputListPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );
      const concatExitCode = await execWithDebug(
        ffmpeg,
        [
          "-nostdin",
          "-y",
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
          timelineOutputPath
        ],
        "fast-concat-copy"
      );
      if (concatExitCode !== 0) {
        throw new Error("fast-path-failed");
      }
    }
  } catch (error) {
    const fastPathFailed = error instanceof Error && error.message === "fast-path-failed";
    if (!fastPathFailed) {
      throw error;
    }

    const fallbackNeedsStretch =
      hasResolutionMismatch && exportMode === "fast" && !shouldNormalize && !shouldStretchResize;
    const reencodeFilters = [...baseFilters];
    if (fallbackNeedsStretch) {
      reencodeFilters.unshift(stretchScaleFilter);
    }
    const reencodeVideoFilter = reencodeFilters.length > 0 ? reencodeFilters.join(",") : null;

    options.onStageChange?.(
      "processing-reencode",
      shouldNormalize
        ? "Normalizing resolution (software encode, may take a while)..."
        : fallbackNeedsStretch || shouldStretchResize
          ? "Applying export resolution (software encode, may take a while)..."
          : shouldApplyFps
            ? "Applying export FPS (software encode, may take a while)..."
            : "Re-encoding timeline segments..."
    );
    options.onProgress?.(0.1);
    await cleanupFiles(ffmpeg, [...segmentPaths, inputListPath, timelineOutputPath]);

    const segmentTotal = sanitizedSegments.length;
    for (const [index, segment] of sanitizedSegments.entries()) {
      const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
      const sourcePath = fileKeyToPath.get(key);
      if (!sourcePath) {
        throw new Error("Source path not found during re-encode export.");
      }

      const duration = segment.endSec - segment.startSec;
      const segmentPath = segmentPaths[index];
      const reencodeArgs: string[] = [
        "-nostdin",
        "-y",
        "-ss",
        toFfmpegSeconds(segment.startSec),
        "-t",
        toFfmpegSeconds(duration),
        "-i",
        sourcePath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?"
      ];

      if (reencodeVideoFilter) {
        reencodeArgs.push("-vf", reencodeVideoFilter);
      }

      reencodeArgs.push(
        "-c:v",
        "libx264",
        "-preset",
        reencodePreset,
        "-crf",
        reencodeCrf,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        reencodeAudioBitrate,
        segmentPath
      );

      const exitCode = await execWithDebug(ffmpeg, reencodeArgs, `reencode-segment-${index}`);

      if (exitCode !== 0) {
        throw new Error("Export failed while re-encoding timeline segment.");
      }

      options.onProgress?.(0.1 + ((index + 1) / segmentTotal) * 0.6);
    }

    if (segmentPaths.length === 1) {
      const cloneExitCode = await execWithDebug(
        ffmpeg,
        [
          "-nostdin",
          "-y",
          "-i",
          segmentPaths[0],
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          timelineOutputPath
        ],
        "reencode-finalize-single"
      );
      if (cloneExitCode !== 0) {
        throw new Error("Export failed while finalizing single segment.");
      }
    } else {
      await ffmpeg.writeFile(
        inputListPath,
        segmentPaths.map((path) => `file '${path}'`).join("\n")
      );

      let concatExitCode = await execWithDebug(
        ffmpeg,
        [
          "-nostdin",
          "-y",
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
          timelineOutputPath
        ],
        "reencode-concat-copy"
      );

      if (concatExitCode !== 0) {
        concatExitCode = await execWithDebug(
          ffmpeg,
          [
            "-nostdin",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            inputListPath,
            "-c:v",
            "libx264",
            "-preset",
            reencodePreset,
            "-crf",
            reencodeCrf,
            "-c:a",
            "aac",
            "-b:a",
            reencodeAudioBitrate,
            "-movflags",
            "+faststart",
            timelineOutputPath
          ],
          "reencode-concat-transcode"
        );
      }

      if (concatExitCode !== 0) {
        throw new Error("Export failed while concatenating segments.");
      }
    }
  }

  try {
    if (exportFormat !== "mp4") {
      options.onStageChange?.("finalizing", `Converting to ${exportFormat.toUpperCase()}...`);
      options.onProgress?.(0.92);

      if (exportFormat === "gif") {
        const palettePath = `${runId}-palette.png`;
        tempPaths.push(palettePath);
        const gifFps = targetFps ?? 15;
        const gifFilter = `fps=${gifFps}`;

        const paletteExitCode = await execWithDebug(
          ffmpeg,
          [
            "-nostdin",
            "-y",
            "-i",
            timelineOutputPath,
            "-frames:v",
            "1",
            "-vf",
            `${gifFilter},palettegen`,
            palettePath
          ],
          "format-gif-palette"
        );
        if (paletteExitCode !== 0) {
          throw new Error("Failed while generating GIF palette.");
        }

        const gifExitCode = await execWithDebug(
          ffmpeg,
          [
            "-nostdin",
            "-y",
            "-i",
            timelineOutputPath,
            "-i",
            palettePath,
            "-lavfi",
            `${gifFilter}[v];[v][1:v]paletteuse=dither=sierra2_4a`,
            "-an",
            finalOutputPath
          ],
          "format-gif-encode"
        );
        if (gifExitCode !== 0) {
          throw new Error("Failed while encoding GIF output.");
        }
      } else {
        const formatArgs: string[] = [
          "-nostdin",
          "-y",
          "-i",
          timelineOutputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?"
        ];

        if (exportFormat === "mov" || exportFormat === "mkv") {
          formatArgs.push(
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k"
          );
          if (exportFormat === "mov") {
            formatArgs.push("-movflags", "+faststart");
          }
        } else if (exportFormat === "avi") {
          formatArgs.push(
            "-c:v",
            "mpeg4",
            "-q:v",
            "5",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k"
          );
        } else if (exportFormat === "webm") {
          formatArgs.push(
            "-c:v",
            "libvpx",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-deadline",
            "realtime",
            "-cpu-used",
            "5",
            "-c:a",
            "libopus",
            "-b:a",
            "96k"
          );
        }

        formatArgs.push(finalOutputPath);
        const convertExitCode = await execWithDebug(ffmpeg, formatArgs, `format-${exportFormat}`);
        if (convertExitCode !== 0) {
          throw new Error(`Failed while converting output to ${exportFormat}.`);
        }
      }
    }

    options.onStageChange?.("finalizing", "Finalizing exported video...");
    options.onProgress?.(0.97);
    const outputData = await ffmpeg.readFile(finalOutputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected export output format.");
    }
    options.onProgress?.(1);
    return toBlob(outputData, formatConfig.mimeType);
  } finally {
    await cleanupFiles(ffmpeg, [
      ...sourcePaths,
      ...segmentPaths,
      ...tempPaths,
      inputListPath,
      timelineOutputPath,
      ...(finalOutputPath === timelineOutputPath ? [] : [finalOutputPath])
    ]);
  }
}
