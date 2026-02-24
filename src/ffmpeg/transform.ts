import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg } from "./client";

export type TransformStage =
  | "loading-core"
  | "preparing-input"
  | "processing"
  | "finalizing";

export interface TransformOptions {
  onStageChange?: (stage: TransformStage, message: string) => void;
  onProgress?: (value: number) => void;
}

export interface CropConfig {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResizeConfig {
  width: number;
  height: number;
}

export interface TransformConfig {
  crop?: CropConfig;
  resize?: ResizeConfig;
}

function sanitizeExtension(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!/^[a-z0-9]+$/.test(extension)) {
    return "mp4";
  }
  return extension;
}

function toEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function toBlob(data: Uint8Array): Blob {
  const standardBuffer = new Uint8Array(data.byteLength);
  standardBuffer.set(data);
  return new Blob([standardBuffer], { type: "video/mp4" });
}

async function cleanupFiles(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>, paths: string[]) {
  await Promise.all(paths.map((path) => ffmpeg.deleteFile(path).catch(() => false)));
}

export async function transformVideo(
  file: File,
  config: TransformConfig,
  options: TransformOptions = {}
): Promise<Blob> {
  if (!config.crop && !config.resize) {
    throw new Error("No crop/resize transform was configured.");
  }

  const filters: string[] = [];
  if (config.crop) {
    const cropWidth = toEvenDimension(config.crop.width);
    const cropHeight = toEvenDimension(config.crop.height);
    const cropX = Math.max(0, Math.floor(config.crop.x));
    const cropY = Math.max(0, Math.floor(config.crop.y));
    filters.push(`crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`);
  }

  if (config.resize) {
    const resizeWidth = toEvenDimension(config.resize.width);
    const resizeHeight = toEvenDimension(config.resize.height);
    filters.push(`scale=${resizeWidth}:${resizeHeight}:flags=lanczos`);
  }

  if (filters.length === 0) {
    throw new Error("No valid FFmpeg filters generated for the transform.");
  }

  options.onStageChange?.("loading-core", "Loading FFmpeg core...");
  options.onProgress?.(0);
  const ffmpeg = await getFFmpeg();

  const runId = `transform-${Date.now().toString(36)}`;
  const extension = sanitizeExtension(file.name);
  const inputPath = `${runId}-input.${extension}`;
  const outputPath = `${runId}-output.mp4`;

  const progressListener = ({ progress }: { progress: number }) => {
    const normalized = Math.min(1, Math.max(0, progress));
    options.onProgress?.(normalized);
  };
  ffmpeg.on("progress", progressListener);

  try {
    options.onStageChange?.("preparing-input", "Preparing source file...");
    await ffmpeg.writeFile(inputPath, await fetchFile(file));

    options.onStageChange?.("processing", "Applying filters...");
    const exitCode = await ffmpeg.exec([
      "-i",
      inputPath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-vf",
      filters.join(","),
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
      throw new Error("Crop/resize transform failed.");
    }

    options.onStageChange?.("finalizing", "Finalizing transformed output...");
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
