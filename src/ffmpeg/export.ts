import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type ExportStage =
  | "loading-core"
  | "preparing-inputs"
  | "processing-fast"
  | "processing-reencode"
  | "finalizing";

export type ExportMode = "fit" | "fast";
export type ExportFormat =
  | "mp4"
  | "mov"
  | "avi"
  | "mkv"
  | "gif"
  | "mp3"
  | "wav";

interface ExportFormatConfig {
  extension: string;
  mimeType: string;
  supportsVideo: boolean;
  supportsAudio: boolean;
}

export interface ExportSegment {
  file: File;
  startSec: number;
  endSec: number;
  speed: number;
  scale: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
}

export interface ExportCropConfig {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  mode?: ExportMode;
  format?: ExportFormat;
  outputWidth?: number;
  outputHeight?: number;
  workspaceWidth?: number;
  workspaceHeight?: number;
  crop?: ExportCropConfig;
  fps?: number;
  includeVideo?: boolean;
  includeAudio?: boolean;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  onStageChange?: (stage: ExportStage, message: string) => void;
  onProgress?: (value: number) => void;
  onFrameProgress?: (currentFrame: number, totalFrames: number, percent: number) => void;
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
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

function normalizeOptionalBitrateKbps(
  value: number | undefined,
  min: number,
  max: number
): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value as number);
  if (rounded <= 0) {
    return null;
  }

  return Math.min(max, Math.max(min, rounded));
}

function normalizeSpeed(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.min(1000, Math.max(0.001, value));
}

function normalizeSegmentScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return clamp(value, 0.001, 1000);
}

function normalizePan(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function isSpeedNeutral(value: number): boolean {
  return Math.abs(value - 1) <= 0.000001;
}

function isTransformNeutral(scale: number, panX: number, panY: number): boolean {
  return (
    Math.abs(scale - 1) <= 0.000001 &&
    Math.abs(panX) <= 0.000001 &&
    Math.abs(panY) <= 0.000001
  );
}

function buildAtempoFilter(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;

  while (remaining < 0.5 - 0.000001) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  while (remaining > 2 + 0.000001) {
    filters.push("atempo=2");
    remaining /= 2;
  }

  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters.join(",");
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function toFrameCount(durationSec: number, fps: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(durationSec * fps));
}

function normalizeCropConfig(
  crop: ExportOptions["crop"],
  workspaceWidth: number,
  workspaceHeight: number
): ExportCropConfig {
  const fallback: ExportCropConfig = {
    enabled: false,
    x: 0,
    y: 0,
    width: workspaceWidth,
    height: workspaceHeight
  };

  if (!crop) {
    return fallback;
  }

  const width = toEvenDimension(clamp(Math.round(crop.width), 2, workspaceWidth));
  const height = toEvenDimension(clamp(Math.round(crop.height), 2, workspaceHeight));
  const maxX = Math.max(0, workspaceWidth - width);
  const maxY = Math.max(0, workspaceHeight - height);
  const x = clamp(Math.round(crop.x), 0, maxX);
  const y = clamp(Math.round(crop.y), 0, maxY);

  return {
    enabled: Boolean(crop.enabled),
    x,
    y,
    width,
    height
  };
}

function hasEffectiveCrop(crop: ExportCropConfig, workspaceWidth: number, workspaceHeight: number): boolean {
  if (!crop.enabled) {
    return false;
  }
  return crop.x !== 0 || crop.y !== 0 || crop.width !== workspaceWidth || crop.height !== workspaceHeight;
}

const EXPORT_FORMAT_CONFIG: Record<ExportFormat, ExportFormatConfig> = {
  mp4: {
    extension: "mp4",
    mimeType: "video/mp4",
    supportsVideo: true,
    supportsAudio: true
  },
  mov: {
    extension: "mov",
    mimeType: "video/quicktime",
    supportsVideo: true,
    supportsAudio: true
  },
  avi: {
    extension: "avi",
    mimeType: "video/x-msvideo",
    supportsVideo: true,
    supportsAudio: true
  },
  mkv: {
    extension: "mkv",
    mimeType: "video/x-matroska",
    supportsVideo: true,
    supportsAudio: true
  },
  gif: {
    extension: "gif",
    mimeType: "image/gif",
    supportsVideo: true,
    supportsAudio: false
  },
  mp3: {
    extension: "mp3",
    mimeType: "audio/mpeg",
    supportsVideo: false,
    supportsAudio: true
  },
  wav: {
    extension: "wav",
    mimeType: "audio/wav",
    supportsVideo: false,
    supportsAudio: true
  }
};

class FrameProgressTracker {
  private plannedFrames = 0;
  private completedFrames = 0;
  private activeFrameBudget = 0;
  private activeFrameProgress = 0;
  private hasActiveCommand = false;

  constructor(private readonly options: ExportOptions) {}

  public addPlannedFrames(frames: number): void {
    const safeFrames = Math.max(0, Math.round(frames));
    if (safeFrames <= 0) {
      return;
    }
    this.plannedFrames += safeFrames;
    this.emit();
  }

  public beginCommand(frameBudget: number): void {
    const safeBudget = Math.max(0, Math.round(frameBudget));
    this.activeFrameBudget = safeBudget;
    this.activeFrameProgress = 0;
    this.hasActiveCommand = safeBudget > 0;
    this.emit();
  }

  public updateCommandProgress(progress: number): void {
    if (!this.hasActiveCommand || this.activeFrameBudget <= 0) {
      return;
    }
    this.activeFrameProgress = clampUnit(progress);
    this.emit();
  }

  public endCommand(success: boolean): void {
    if (this.hasActiveCommand && this.activeFrameBudget > 0) {
      const completedForCommand = success
        ? this.activeFrameBudget
        : Math.round(this.activeFrameBudget * this.activeFrameProgress);
      this.completedFrames += Math.max(0, completedForCommand);
    }

    this.activeFrameBudget = 0;
    this.activeFrameProgress = 0;
    this.hasActiveCommand = false;
    this.emit();
  }

  public markComplete(): void {
    if (this.plannedFrames <= 0) {
      this.options.onProgress?.(1);
      this.options.onFrameProgress?.(0, 0, 1);
      return;
    }

    this.completedFrames = this.plannedFrames;
    this.activeFrameBudget = 0;
    this.activeFrameProgress = 0;
    this.hasActiveCommand = false;
    this.emit();
  }

  private emit(): void {
    if (this.plannedFrames <= 0) {
      this.options.onProgress?.(0);
      this.options.onFrameProgress?.(0, 0, 0);
      return;
    }

    const totalFrames = Math.max(1, Math.round(this.plannedFrames));
    const processedFramesRaw =
      this.completedFrames + this.activeFrameBudget * this.activeFrameProgress;
    const processedFrames = Math.round(
      Math.min(totalFrames, Math.max(0, processedFramesRaw))
    );
    const percent = clampUnit(processedFrames / totalFrames);

    this.options.onProgress?.(percent);
    this.options.onFrameProgress?.(processedFrames, totalFrames, percent);
  }
}

export function getExportFormatConfig(format: ExportFormat): ExportFormatConfig {
  return EXPORT_FORMAT_CONFIG[format];
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
  const normalizedArgs = args.map((arg, index) => {
    if (typeof arg !== "string") {
      throw new Error(
        `Invalid ffmpeg argument at index ${index} for ${label}. Expected string, got ${typeof arg}.`
      );
    }
    return arg;
  });

  console.log(`[ffmpeg.exec:${label}] ${normalizedArgs.join(" ")}`);
  const startedAt = performance.now();
  try {
    const exitCode = await ffmpeg.exec(normalizedArgs);
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
      speed: normalizeSpeed(segment.speed),
      scale: normalizeSegmentScale(segment.scale),
      panX: normalizePan(segment.panX),
      panY: normalizePan(segment.panY),
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
  const formatConfig = getExportFormatConfig(exportFormat);
  const includeVideo = formatConfig.supportsVideo && (options.includeVideo ?? true);
  const includeAudio = formatConfig.supportsAudio && (options.includeAudio ?? true);
  if (!includeVideo && !includeAudio) {
    throw new Error("Enable at least one stream (video or audio) before exporting.");
  }

  const videoBitrateKbps = includeVideo
    ? normalizeOptionalBitrateKbps(options.videoBitrateKbps, 100, 200_000)
    : null;
  const audioBitrateKbps = includeAudio
    ? normalizeOptionalBitrateKbps(options.audioBitrateKbps, 8, 3_200)
    : null;
  const requestedWorkspaceWidth =
    Number.isFinite(options.workspaceWidth) && (options.workspaceWidth as number) > 0
      ? toEvenDimension(options.workspaceWidth as number)
      : Number.isFinite(options.outputWidth) && (options.outputWidth as number) > 0
        ? toEvenDimension(options.outputWidth as number)
        : null;
  const requestedWorkspaceHeight =
    Number.isFinite(options.workspaceHeight) && (options.workspaceHeight as number) > 0
      ? toEvenDimension(options.workspaceHeight as number)
      : Number.isFinite(options.outputHeight) && (options.outputHeight as number) > 0
        ? toEvenDimension(options.outputHeight as number)
        : null;
  const hasCustomWorkspace =
    requestedWorkspaceWidth !== null && requestedWorkspaceHeight !== null;
  const workspaceWidth = requestedWorkspaceWidth ?? toEvenDimension(largestSegment.width);
  const workspaceHeight = requestedWorkspaceHeight ?? toEvenDimension(largestSegment.height);
  const targetFps = normalizeOptionalFps(options.fps);
  const hasWorkspaceMismatch = sanitizedSegments.some(
    (segment) => segment.width !== workspaceWidth || segment.height !== workspaceHeight
  );
  const hasSpeedChange = sanitizedSegments.some((segment) => !isSpeedNeutral(segment.speed));
  const hasPieceTransform = sanitizedSegments.some(
    (segment) => !isTransformNeutral(segment.scale, segment.panX, segment.panY)
  );
  const cropConfig = normalizeCropConfig(options.crop, workspaceWidth, workspaceHeight);
  const shouldApplyCrop = includeVideo && hasEffectiveCrop(cropConfig, workspaceWidth, workspaceHeight);
  const needsWorkspaceComposition =
    includeVideo && (hasWorkspaceMismatch || hasCustomWorkspace || hasPieceTransform || shouldApplyCrop);
  const shouldApplyFps = includeVideo && targetFps !== null;
  const canUseFastPath =
    !needsWorkspaceComposition && !shouldApplyFps && !hasSpeedChange;
  const needsFinalConvert =
    exportFormat !== "mp4" ||
    !includeVideo ||
    !includeAudio ||
    videoBitrateKbps !== null ||
    audioBitrateKbps !== null;
  const reencodePreset = needsWorkspaceComposition || hasSpeedChange || shouldApplyFps ? "ultrafast" : "veryfast";
  const reencodeCrf = needsWorkspaceComposition || hasSpeedChange || shouldApplyFps ? "28" : "23";
  const reencodeAudioBitrate = hasSpeedChange ? "96k" : "128k";
  const progressFps = targetFps ?? 30;
  const segmentFrameBudgets = sanitizedSegments.map((segment) => {
    const timelineDuration = (segment.endSec - segment.startSec) / Math.max(0.001, segment.speed);
    return toFrameCount(timelineDuration, progressFps);
  });
  const timelineFrameBudget = segmentFrameBudgets.reduce((sum, frames) => sum + frames, 0);
  const fastPathFrameBudget =
    canUseFastPath && !needsFinalConvert ? timelineFrameBudget : 0;
  const reencodeFrameBudget = canUseFastPath ? 0 : timelineFrameBudget;
  const finalConvertFrameBudget = needsFinalConvert
    ? exportFormat === "gif"
      ? timelineFrameBudget * 2
      : timelineFrameBudget
    : 0;
  const baselinePlannedFrameBudget =
    fastPathFrameBudget + reencodeFrameBudget + finalConvertFrameBudget;
  const trackedFastSegmentFrameBudgets =
    fastPathFrameBudget > 0 ? segmentFrameBudgets : segmentFrameBudgets.map(() => 0);
  const frameTracker = new FrameProgressTracker(options);

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  options.onFrameProgress?.(0, Math.max(1, baselinePlannedFrameBudget), 0);
  frameTracker.addPlannedFrames(baselinePlannedFrameBudget);
  const ffmpeg = await getFFmpeg();
  attachFfmpegDebugListener(ffmpeg);
  let activeCommandTracking = false;
  const progressListener = ({ progress }: { progress: number }) => {
    if (!activeCommandTracking) {
      return;
    }
    frameTracker.updateCommandProgress(progress);
  };
  ffmpeg.on("progress", progressListener);
  console.log("[export] config", {
    segmentCount: sanitizedSegments.length,
    exportMode,
    exportFormat,
    includeVideo,
    includeAudio,
    videoBitrateKbps,
    audioBitrateKbps,
    hasCustomWorkspace,
    hasWorkspaceMismatch,
    hasPieceTransform,
    hasSpeedChange,
    targetFps,
    workspaceWidth,
    workspaceHeight,
    cropConfig,
    shouldApplyCrop,
    canUseFastPath,
    needsFinalConvert,
    needsWorkspaceComposition,
    reencodePreset,
    reencodeCrf,
    reencodeAudioBitrate,
    fastPathFrameBudget,
    reencodeFrameBudget,
    finalConvertFrameBudget,
    baselinePlannedFrameBudget
  });

  const runId = `export-${Date.now().toString(36)}`;
  const sourcePaths: string[] = [];
  const segmentPaths: string[] = [];
  const tempPaths: string[] = [];
  const inputListPath = `${runId}-segments.txt`;
  const timelineOutputPath = `${runId}-timeline.mp4`;
  const finalOutputPath = needsFinalConvert
    ? `${runId}-output.${formatConfig.extension}`
    : timelineOutputPath;

  const fileKeyToPath = new Map<string, string>();

  async function runCommandWithFrameProgress(
    args: string[],
    label: string,
    frameBudget: number
  ): Promise<number> {
    const safeBudget = Math.max(0, Math.round(frameBudget));
    frameTracker.beginCommand(safeBudget);
    activeCommandTracking = safeBudget > 0;
    let success = false;
    try {
      const exitCode = await execWithDebug(ffmpeg, args, label);
      success = exitCode === 0;
      return exitCode;
    } finally {
      activeCommandTracking = false;
      frameTracker.endCommand(success);
    }
  }

  try {
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
        const exitCode = await runCommandWithFrameProgress(
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
          `fast-segment-${index}`,
          trackedFastSegmentFrameBudgets[index] ?? 0
        );

        if (exitCode !== 0) {
          throw new Error("fast-path-failed");
        }
      }

      if (segmentPaths.length === 1) {
        const cloneExitCode = await runCommandWithFrameProgress(
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
          "fast-finalize-single",
          0
        );
        if (cloneExitCode !== 0) {
          throw new Error("fast-path-failed");
        }
      } else {
        await ffmpeg.writeFile(
          inputListPath,
          segmentPaths.map((path) => `file '${path}'`).join("\n")
        );
        const concatExitCode = await runCommandWithFrameProgress(
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
          "fast-concat-copy",
          0
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

      if (canUseFastPath) {
        frameTracker.addPlannedFrames(timelineFrameBudget);
      }

      const reencodeMessage = needsWorkspaceComposition
        ? "Compositing timeline into workspace (software encode, may take a while)..."
        : shouldApplyFps
          ? "Applying export FPS (software encode, may take a while)..."
          : hasSpeedChange
            ? "Applying speed changes (software encode, may take a while)..."
            : "Re-encoding timeline segments...";
      options.onStageChange?.(
        "processing-reencode",
        reencodeMessage
      );
      await cleanupFiles(ffmpeg, [...segmentPaths, inputListPath, timelineOutputPath]);

      for (const [index, segment] of sanitizedSegments.entries()) {
        const key = `${segment.file.name}:${segment.file.size}:${segment.file.lastModified}`;
        const sourcePath = fileKeyToPath.get(key);
        if (!sourcePath) {
          throw new Error("Source path not found during re-encode export.");
        }

        const duration = segment.endSec - segment.startSec;
        const segmentPath = segmentPaths[index];
        const segmentVideoFilters: string[] = [];
        if (includeVideo) {
          segmentVideoFilters.push(
            `scale=${workspaceWidth}:${workspaceHeight}:force_original_aspect_ratio=decrease,` +
              `pad=${workspaceWidth}:${workspaceHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
          );

          const hasSegmentTransform = !isTransformNeutral(
            segment.scale,
            segment.panX,
            segment.panY
          );
          let internalPanX = 0;
          let internalPanY = 0;

          if (hasSegmentTransform) {
            const scaledWidth = Math.max(2, toEvenDimension(workspaceWidth * segment.scale));
            const scaledHeight = Math.max(2, toEvenDimension(workspaceHeight * segment.scale));
            segmentVideoFilters.push(`scale=${scaledWidth}:${scaledHeight}:flags=lanczos`);

            const internalMaxPanX = Math.abs(scaledWidth - workspaceWidth) / 2;
            const internalMaxPanY = Math.abs(scaledHeight - workspaceHeight) / 2;
            internalPanX = clamp(segment.panX, -internalMaxPanX, internalMaxPanX);
            internalPanY = clamp(segment.panY, -internalMaxPanY, internalMaxPanY);

            if (scaledWidth >= workspaceWidth && scaledHeight >= workspaceHeight) {
              const cropX = Math.round((scaledWidth - workspaceWidth) / 2 - internalPanX);
              const cropY = Math.round((scaledHeight - workspaceHeight) / 2 - internalPanY);
              segmentVideoFilters.push(`crop=${workspaceWidth}:${workspaceHeight}:${cropX}:${cropY}`);
            } else {
              const padX = Math.round((workspaceWidth - scaledWidth) / 2 + internalPanX);
              const padY = Math.round((workspaceHeight - scaledHeight) / 2 + internalPanY);
              segmentVideoFilters.push(
                `pad=${workspaceWidth}:${workspaceHeight}:${padX}:${padY}:color=black`
              );
            }
          }

          if (hasSegmentTransform || shouldApplyCrop) {
            const outW = shouldApplyCrop ? cropConfig.width : workspaceWidth;
            const outH = shouldApplyCrop ? cropConfig.height : workspaceHeight;
            const anchorX = shouldApplyCrop ? cropConfig.x : 0;
            const anchorY = shouldApplyCrop ? cropConfig.y : 0;

            const remainingPanX = segment.panX - internalPanX;
            const remainingPanY = segment.panY - internalPanY;
            const remMinX = anchorX - workspaceWidth;
            const remMaxX = anchorX + outW;
            const remMinY = anchorY - workspaceHeight;
            const remMaxY = anchorY + outH;
            const clampedRemainingX = clamp(remainingPanX, remMinX, remMaxX);
            const clampedRemainingY = clamp(remainingPanY, remMinY, remMaxY);

            const paddedWidth = workspaceWidth + outW * 2;
            const paddedHeight = workspaceHeight + outH * 2;
            segmentVideoFilters.push(
              `pad=${paddedWidth}:${paddedHeight}:${outW}:${outH}:color=black`
            );
            const cropX = Math.round(outW + anchorX - clampedRemainingX);
            const cropY = Math.round(outH + anchorY - clampedRemainingY);
            segmentVideoFilters.push(`crop=${outW}:${outH}:${cropX}:${cropY}`);
          }

          if (!isSpeedNeutral(segment.speed)) {
            segmentVideoFilters.push(`setpts=PTS/${segment.speed.toFixed(6)}`);
          }

          if (shouldApplyFps && targetFps !== null) {
            segmentVideoFilters.push(`fps=${targetFps}`);
          }
        }
        const segmentVideoFilter =
          segmentVideoFilters.length > 0 ? segmentVideoFilters.join(",") : null;
        const segmentAudioFilter = includeAudio && !isSpeedNeutral(segment.speed)
          ? buildAtempoFilter(segment.speed)
          : null;
        const reencodeArgs: string[] = [
          "-nostdin",
          "-y",
          "-ss",
          toFfmpegSeconds(segment.startSec),
          "-t",
          toFfmpegSeconds(duration),
          "-i",
          sourcePath
        ];

        if (includeVideo) {
          reencodeArgs.push("-map", "0:v:0?");
        } else {
          reencodeArgs.push("-vn");
        }

        if (includeAudio) {
          reencodeArgs.push("-map", "0:a:0?");
        } else {
          reencodeArgs.push("-an");
        }

        if (segmentVideoFilter) {
          reencodeArgs.push("-vf", segmentVideoFilter);
        }

        if (segmentAudioFilter) {
          reencodeArgs.push("-af", segmentAudioFilter);
        }

        if (includeVideo) {
          reencodeArgs.push(
            "-c:v",
            "libx264",
            "-preset",
            reencodePreset,
            "-crf",
            reencodeCrf,
            "-pix_fmt",
            "yuv420p"
          );
        }

        if (includeAudio) {
          reencodeArgs.push("-c:a", "aac", "-b:a", reencodeAudioBitrate);
        }

        reencodeArgs.push(segmentPath);

        const exitCode = await runCommandWithFrameProgress(
          reencodeArgs,
          `reencode-segment-${index}`,
          segmentFrameBudgets[index] ?? 0
        );

        if (exitCode !== 0) {
          throw new Error("Export failed while re-encoding timeline segment.");
        }
      }

      if (segmentPaths.length === 1) {
        const cloneExitCode = await runCommandWithFrameProgress(
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
          "reencode-finalize-single",
          0
        );
        if (cloneExitCode !== 0) {
          throw new Error("Export failed while finalizing single segment.");
        }
      } else {
        await ffmpeg.writeFile(
          inputListPath,
          segmentPaths.map((path) => `file '${path}'`).join("\n")
        );

        let concatExitCode = await runCommandWithFrameProgress(
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
          "reencode-concat-copy",
          0
        );

        if (concatExitCode !== 0) {
          frameTracker.addPlannedFrames(timelineFrameBudget);
          const concatTranscodeArgs: string[] = [
            "-nostdin",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            inputListPath
          ];
          if (includeVideo) {
            concatTranscodeArgs.push(
              "-map",
              "0:v:0?",
              "-c:v",
              "libx264",
              "-preset",
              reencodePreset,
              "-crf",
              reencodeCrf,
              "-pix_fmt",
              "yuv420p"
            );
          } else {
            concatTranscodeArgs.push("-vn");
          }
          if (includeAudio) {
            concatTranscodeArgs.push(
              "-map",
              "0:a:0?",
              "-c:a",
              "aac",
              "-b:a",
              reencodeAudioBitrate
            );
          } else {
            concatTranscodeArgs.push("-an");
          }
          concatTranscodeArgs.push("-movflags", "+faststart", timelineOutputPath);
          concatExitCode = await runCommandWithFrameProgress(
            concatTranscodeArgs,
            "reencode-concat-transcode",
            timelineFrameBudget
          );
        }

        if (concatExitCode !== 0) {
          throw new Error("Export failed while concatenating segments.");
        }
      }
    }

    if (needsFinalConvert) {
      options.onStageChange?.("finalizing", `Converting to .${formatConfig.extension}...`);

      if (exportFormat === "gif") {
        const palettePath = `${runId}-palette.png`;
        tempPaths.push(palettePath);
        const gifFps = targetFps ?? 15;
        const gifFilter = `fps=${gifFps}`;

        const paletteExitCode = await runCommandWithFrameProgress(
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
          "format-gif-palette",
          timelineFrameBudget
        );
        if (paletteExitCode !== 0) {
          throw new Error("Failed while generating GIF palette.");
        }

        const gifExitCode = await runCommandWithFrameProgress(
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
          "format-gif-encode",
          timelineFrameBudget
        );
        if (gifExitCode !== 0) {
          throw new Error("Failed while encoding GIF output.");
        }
      } else {
        const formatArgs: string[] = ["-nostdin", "-y", "-i", timelineOutputPath];
        if (includeVideo) {
          formatArgs.push("-map", "0:v:0?");
        } else {
          formatArgs.push("-vn");
        }
        if (includeAudio) {
          formatArgs.push("-map", "0:a:0?");
        } else {
          formatArgs.push("-an");
        }

        switch (exportFormat) {
          case "mp4":
          case "mov":
          case "mkv": {
            if (includeVideo) {
              formatArgs.push(
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p"
              );
              if (videoBitrateKbps !== null) {
                formatArgs.push("-b:v", `${videoBitrateKbps}k`);
              }
            }
            if (includeAudio) {
              formatArgs.push("-c:a", "aac", "-b:a", `${audioBitrateKbps ?? 128}k`);
            }
            if (exportFormat === "mov") {
              formatArgs.push("-movflags", "+faststart");
            }
            break;
          }
          case "avi": {
            if (includeVideo) {
              formatArgs.push("-c:v", "mpeg4", "-q:v", "5");
              if (videoBitrateKbps !== null) {
                formatArgs.push("-b:v", `${videoBitrateKbps}k`);
              }
            }
            if (includeAudio) {
              formatArgs.push("-c:a", "libmp3lame", "-b:a", `${audioBitrateKbps ?? 128}k`);
            }
            break;
          }
          case "mp3": {
            if (!includeAudio) {
              throw new Error("MP3 export requires audio enabled.");
            }
            formatArgs.push("-vn", "-c:a", "libmp3lame", "-b:a", `${audioBitrateKbps ?? 192}k`);
            break;
          }
          case "wav": {
            if (!includeAudio) {
              throw new Error("WAV export requires audio enabled.");
            }
            formatArgs.push("-vn", "-c:a", "pcm_s16le");
            break;
          }
          default:
            throw new Error(`Unsupported export format: ${exportFormat}`);
        }

        formatArgs.push(finalOutputPath);
        const convertExitCode = await runCommandWithFrameProgress(
          formatArgs,
          `format-${exportFormat}`,
          timelineFrameBudget
        );
        if (convertExitCode !== 0) {
          throw new Error(`Failed while converting output to ${exportFormat}.`);
        }
      }
    }

    options.onStageChange?.("finalizing", "Finalizing exported video...");
    const outputData = await ffmpeg.readFile(finalOutputPath);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error("Unexpected export output format.");
    }
    frameTracker.markComplete();
    return toBlob(outputData, formatConfig.mimeType);
  } finally {
    ffmpeg.off("progress", progressListener);
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
