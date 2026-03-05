import {
  MAX_PIECE_SCALE,
  MAX_PIECE_SCALE_LOG,
  MAX_SEGMENT_SPEED,
  MAX_SEGMENT_SPEED_LOG,
  MIN_PIECE_SCALE,
  MIN_PIECE_SCALE_LOG,
  MIN_SEGMENT_SPEED,
  MIN_SEGMENT_SPEED_LOG
} from "./constants";

export function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.000001;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatSecondsLabel(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(2)}s`;
}

export function formatEta(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  const sizeMb = bytes / (1024 * 1024);
  return `${sizeMb.toFixed(2)} MB`;
}

export function clampSpeed(value: number): number {
  return clamp(value, MIN_SEGMENT_SPEED, MAX_SEGMENT_SPEED);
}

export function speedToLogSliderValue(speed: number): number {
  return clamp(Math.log10(clampSpeed(speed)), MIN_SEGMENT_SPEED_LOG, MAX_SEGMENT_SPEED_LOG);
}

export function logSliderValueToSpeed(value: number): number {
  return clampSpeed(10 ** clamp(value, MIN_SEGMENT_SPEED_LOG, MAX_SEGMENT_SPEED_LOG));
}

export function formatSpeedLabel(speed: number): string {
  return Number(clampSpeed(speed).toPrecision(6)).toString();
}

export function clampPieceScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, MIN_PIECE_SCALE, MAX_PIECE_SCALE);
}

export function scaleToLogSliderValue(scale: number): number {
  return clamp(Math.log10(clampPieceScale(scale)), MIN_PIECE_SCALE_LOG, MAX_PIECE_SCALE_LOG);
}

export function logSliderValueToScale(value: number): number {
  return clampPieceScale(10 ** clamp(value, MIN_PIECE_SCALE_LOG, MAX_PIECE_SCALE_LOG));
}

export function formatScaleLabel(scale: number): string {
  return Number(clampPieceScale(scale).toPrecision(6)).toString();
}

export function normalizePanValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

export function parsePositiveIntegerInput(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

export function parseNonNegativeIntegerInput(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
}

export function durationPartsFromSeconds(seconds: number): {
  minutes: number;
  seconds: number;
  milliseconds: number;
} {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const secondsPart = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return { minutes, seconds: secondsPart, milliseconds };
}

export function normalizeTimeValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function isKeyboardEventFromInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return (
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"
    ) !== null
  );
}

export function isFileDragPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (dataTransfer.files.length > 0) {
    return true;
  }

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === "file") {
      return true;
    }
  }

  return Array.from(dataTransfer.types).includes("Files");
}
