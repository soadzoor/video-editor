import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?url";

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpeg) {
    ffmpeg = new FFmpeg();
  }

  if (ffmpeg.loaded) {
    return ffmpeg;
  }

  if (!loadPromise) {
    loadPromise = ffmpeg
      .load({ coreURL, wasmURL, classWorkerURL })
      .then(() => {
        if (!ffmpeg) {
          throw new Error("FFmpeg instance was not initialized.");
        }
        return ffmpeg;
      })
      .catch((error: unknown) => {
        ffmpeg?.terminate();
        ffmpeg = null;
        throw error;
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}
