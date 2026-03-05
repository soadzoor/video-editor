import type { Dispatch, SetStateAction } from "react";
import {
  clampPieceScale,
  clampSpeed,
  durationPartsFromSeconds,
  formatScaleLabel,
  formatSpeedLabel,
  nearlyEqual,
  normalizePanValue,
  parseNonNegativeIntegerInput
} from "../model/formatters";
import type { CropRect, SourceClip, TimelineDisplayItem, TimelineItem } from "../model/types";

export interface UseEditorSegmentActionsParams {
  selectedTimelineItemId: string | null;
  selectedTimelineItem: TimelineDisplayItem | null;
  isBusy: boolean;
  setTimelineItems: Dispatch<SetStateAction<TimelineItem[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  selectedSpeedInput: string;
  setSelectedSpeedInput: Dispatch<SetStateAction<string>>;
  selectedDurationMinutesInput: string;
  setSelectedDurationMinutesInput: Dispatch<SetStateAction<string>>;
  selectedDurationSecondsInput: string;
  setSelectedDurationSecondsInput: Dispatch<SetStateAction<string>>;
  selectedDurationMillisecondsInput: string;
  setSelectedDurationMillisecondsInput: Dispatch<SetStateAction<string>>;
  selectedScaleInput: string;
  setSelectedScaleInput: Dispatch<SetStateAction<string>>;
  selectedPanXInput: string;
  setSelectedPanXInput: Dispatch<SetStateAction<string>>;
  selectedPanYInput: string;
  setSelectedPanYInput: Dispatch<SetStateAction<string>>;
  clipById: Map<string, SourceClip>;
  workspaceWidth: number;
  workspaceHeight: number;
  normalizedCropRect: CropRect;
}

export function useEditorSegmentActions({
  selectedTimelineItemId,
  selectedTimelineItem,
  isBusy,
  setTimelineItems,
  setError,
  selectedSpeedInput,
  setSelectedSpeedInput,
  selectedDurationMinutesInput,
  setSelectedDurationMinutesInput,
  selectedDurationSecondsInput,
  setSelectedDurationSecondsInput,
  selectedDurationMillisecondsInput,
  setSelectedDurationMillisecondsInput,
  selectedScaleInput,
  setSelectedScaleInput,
  selectedPanXInput,
  setSelectedPanXInput,
  selectedPanYInput,
  setSelectedPanYInput,
  clipById,
  workspaceWidth,
  workspaceHeight,
  normalizedCropRect
}: UseEditorSegmentActionsParams) {
  function setSelectedTimelineSpeed(nextSpeed: number): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    const clampedSpeed = clampSpeed(nextSpeed);
    setTimelineItems((previous) =>
      previous.map((item) =>
        item.id === selectedTimelineItemId
          ? {
              ...item,
              speed: clampedSpeed
            }
          : item
      )
    );
    setError(null);
  }

  function applySelectedDurationInputs(
    minutesText: string,
    secondsText: string,
    millisecondsText: string,
    forceResetOnInvalid: boolean
  ): void {
    if (!selectedTimelineItem) {
      return;
    }

    const minutes = parseNonNegativeIntegerInput(minutesText);
    const seconds = parseNonNegativeIntegerInput(secondsText);
    const milliseconds = parseNonNegativeIntegerInput(millisecondsText);

    if (minutes === null || seconds === null || milliseconds === null) {
      if (forceResetOnInvalid) {
        const fallback = durationPartsFromSeconds(selectedTimelineItem.duration);
        setSelectedDurationMinutesInput(fallback.minutes.toString());
        setSelectedDurationSecondsInput(fallback.seconds.toString());
        setSelectedDurationMillisecondsInput(fallback.milliseconds.toString());
      }
      return;
    }

    const totalMilliseconds = minutes * 60000 + seconds * 1000 + milliseconds;
    if (totalMilliseconds <= 0) {
      if (forceResetOnInvalid) {
        const fallback = durationPartsFromSeconds(selectedTimelineItem.duration);
        setSelectedDurationMinutesInput(fallback.minutes.toString());
        setSelectedDurationSecondsInput(fallback.seconds.toString());
        setSelectedDurationMillisecondsInput(fallback.milliseconds.toString());
      }
      return;
    }

    const sourceDuration = Math.max(
      0,
      selectedTimelineItem.sourceEnd - selectedTimelineItem.sourceStart
    );
    if (sourceDuration <= 0) {
      return;
    }

    const targetDuration = totalMilliseconds / 1000;
    const clampedSpeed = clampSpeed(sourceDuration / targetDuration);
    setSelectedTimelineSpeed(clampedSpeed);
  }

  function setTimelineItemTransformById(
    timelineItemId: string,
    next: {
      scale?: number;
      panX?: number;
      panY?: number;
    }
  ): void {
    if (!timelineItemId || isBusy) {
      return;
    }

    setTimelineItems((previous) => {
      let hasChanged = false;
      const nextItems = previous.map((item) => {
        if (item.id !== timelineItemId) {
          return item;
        }

        const nextScale =
          next.scale === undefined ? clampPieceScale(item.scale) : clampPieceScale(next.scale);
        const nextPanX = next.panX === undefined ? item.panX : normalizePanValue(next.panX);
        const nextPanY = next.panY === undefined ? item.panY : normalizePanValue(next.panY);

        if (
          nearlyEqual(nextScale, item.scale) &&
          nearlyEqual(nextPanX, item.panX) &&
          nearlyEqual(nextPanY, item.panY)
        ) {
          return item;
        }

        hasChanged = true;
        return {
          ...item,
          scale: nextScale,
          panX: nextPanX,
          panY: nextPanY
        };
      });

      return hasChanged ? nextItems : previous;
    });
    setError((previous) => (previous === null ? previous : null));
  }

  function setSelectedTimelineTransform(next: {
    scale?: number;
    panX?: number;
    panY?: number;
  }): void {
    if (!selectedTimelineItemId || isBusy) {
      return;
    }

    setTimelineItemTransformById(selectedTimelineItemId, next);
  }

  function handleSelectedSpeedInputChange(value: string): void {
    setSelectedSpeedInput(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    setSelectedTimelineSpeed(parsed);
  }

  function commitSelectedSpeedInput(): void {
    if (!selectedTimelineItem) {
      return;
    }
    const parsed = Number(selectedSpeedInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSelectedSpeedInput(formatSpeedLabel(selectedTimelineItem.speed));
      return;
    }
    const clampedSpeed = clampSpeed(parsed);
    setSelectedTimelineSpeed(clampedSpeed);
    setSelectedSpeedInput(formatSpeedLabel(clampedSpeed));
  }

  function handleSelectedDurationInputChange(
    part: "minutes" | "seconds" | "milliseconds",
    value: string
  ): void {
    const nextMinutes = part === "minutes" ? value : selectedDurationMinutesInput;
    const nextSeconds = part === "seconds" ? value : selectedDurationSecondsInput;
    const nextMilliseconds =
      part === "milliseconds" ? value : selectedDurationMillisecondsInput;

    if (part === "minutes") {
      setSelectedDurationMinutesInput(value);
    } else if (part === "seconds") {
      setSelectedDurationSecondsInput(value);
    } else {
      setSelectedDurationMillisecondsInput(value);
    }

    applySelectedDurationInputs(nextMinutes, nextSeconds, nextMilliseconds, false);
  }

  function commitSelectedDurationInput(): void {
    applySelectedDurationInputs(
      selectedDurationMinutesInput,
      selectedDurationSecondsInput,
      selectedDurationMillisecondsInput,
      true
    );
  }

  function handleSelectedScaleInputChange(value: string): void {
    setSelectedScaleInput(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    setSelectedTimelineTransform({ scale: parsed });
  }

  function commitSelectedScaleInput(): void {
    if (!selectedTimelineItem) {
      return;
    }

    const parsed = Number(selectedScaleInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const fallback = clampPieceScale(selectedTimelineItem.scale);
      setSelectedScaleInput(formatScaleLabel(fallback));
      return;
    }

    const clampedValue = clampPieceScale(parsed);
    setSelectedTimelineTransform({ scale: clampedValue });
    setSelectedScaleInput(formatScaleLabel(clampedValue));
  }

  function handleSelectedPanInputChange(axis: "x" | "y", value: string): void {
    if (axis === "x") {
      setSelectedPanXInput(value);
    } else {
      setSelectedPanYInput(value);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setSelectedTimelineTransform(axis === "x" ? { panX: parsed } : { panY: parsed });
  }

  function commitSelectedPanInput(axis: "x" | "y"): void {
    if (!selectedTimelineItem) {
      return;
    }

    const raw = axis === "x" ? selectedPanXInput : selectedPanYInput;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      if (axis === "x") {
        setSelectedPanXInput(normalizePanValue(selectedTimelineItem.panX).toString());
      } else {
        setSelectedPanYInput(normalizePanValue(selectedTimelineItem.panY).toString());
      }
      return;
    }

    const normalized = normalizePanValue(parsed);
    setSelectedTimelineTransform(axis === "x" ? { panX: normalized } : { panY: normalized });
    if (axis === "x") {
      setSelectedPanXInput(normalized.toString());
    } else {
      setSelectedPanYInput(normalized.toString());
    }
  }

  function resetSelectedTransform(): void {
    setSelectedTimelineTransform({ scale: 1, panX: 0, panY: 0 });
  }

  function fillSelectedPieceToCrop(): void {
    if (!selectedTimelineItem) {
      return;
    }
    const clip = clipById.get(selectedTimelineItem.sourceClipId);
    if (!clip || clip.width <= 0 || clip.height <= 0) {
      return;
    }

    const baseContainScale = Math.min(workspaceWidth / clip.width, workspaceHeight / clip.height);
    if (!Number.isFinite(baseContainScale) || baseContainScale <= 0) {
      return;
    }
    const baseWidth = clip.width * baseContainScale;
    const baseHeight = clip.height * baseContainScale;
    const targetRect = normalizedCropRect;
    const fillScale = Math.max(targetRect.width / baseWidth, targetRect.height / baseHeight);
    const cropCenterX = targetRect.x + targetRect.width / 2;
    const cropCenterY = targetRect.y + targetRect.height / 2;
    setSelectedTimelineTransform({
      scale: clampPieceScale(fillScale),
      panX: cropCenterX - workspaceWidth / 2,
      panY: cropCenterY - workspaceHeight / 2
    });
  }

  return {
    setSelectedTimelineSpeed,
    setTimelineItemTransformById,
    setSelectedTimelineTransform,
    handleSelectedSpeedInputChange,
    commitSelectedSpeedInput,
    handleSelectedDurationInputChange,
    commitSelectedDurationInput,
    handleSelectedScaleInputChange,
    commitSelectedScaleInput,
    handleSelectedPanInputChange,
    commitSelectedPanInput,
    resetSelectedTransform,
    fillSelectedPieceToCrop
  };
}
