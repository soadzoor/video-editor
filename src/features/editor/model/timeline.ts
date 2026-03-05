import { TIMELINE_SNAP_THRESHOLD_PX } from "./constants";
import { clamp, clampSpeed } from "./formatters";
import type { EditedSegment, TimelineDisplayItem, TimelineItem } from "./types";

export function timelineDurationFromItems(items: TimelineItem[]): number {
  return items.reduce((sum, item) => {
    const sourceDuration = Math.max(0, item.sourceEnd - item.sourceStart);
    const speed = clampSpeed(item.speed);
    return sum + sourceDuration / speed;
  }, 0);
}

export function buildTimelineDisplayItems(items: TimelineItem[]): TimelineDisplayItem[] {
  const displayItems: TimelineDisplayItem[] = [];
  let offset = 0;

  for (const [index, item] of items.entries()) {
    const sourceDuration = Math.max(0, item.sourceEnd - item.sourceStart);
    const speed = clampSpeed(item.speed);
    const duration = sourceDuration / speed;
    if (duration <= 0.001) {
      continue;
    }

    displayItems.push({
      ...item,
      speed,
      index,
      duration,
      timelineStart: offset,
      timelineEnd: offset + duration
    });
    offset += duration;
  }

  return displayItems;
}

export function buildEditedSegments(
  timelineItems: TimelineDisplayItem[],
  trimStartSec: number,
  trimEndSec: number
): EditedSegment[] {
  const totalDuration =
    timelineItems.length > 0 ? timelineItems[timelineItems.length - 1].timelineEnd : 0;
  if (totalDuration <= 0) {
    return [];
  }

  const keepStart = clamp(trimStartSec, 0, totalDuration);
  const keepEnd = clamp(trimEndSec, keepStart, totalDuration);
  if (keepEnd - keepStart <= 0.001) {
    return [];
  }

  let editedOffset = 0;
  const editedSegments: EditedSegment[] = [];

  for (const item of timelineItems) {
    const overlapStart = Math.max(item.timelineStart, keepStart);
    const overlapEnd = Math.min(item.timelineEnd, keepEnd);
    if (overlapEnd - overlapStart <= 0.001) {
      continue;
    }

    const sourceStart = item.sourceStart + (overlapStart - item.timelineStart) * item.speed;
    const sourceEnd = item.sourceStart + (overlapEnd - item.timelineStart) * item.speed;
    const duration = overlapEnd - overlapStart;

    editedSegments.push({
      id: `${item.id}:${sourceStart.toFixed(5)}:${sourceEnd.toFixed(5)}:${item.speed.toFixed(4)}`,
      timelineItemId: item.id,
      clipId: item.sourceClipId,
      sourceStart,
      sourceEnd,
      speed: item.speed,
      scale: item.scale,
      panX: item.panX,
      panY: item.panY,
      timelineStart: overlapStart,
      timelineEnd: overlapEnd,
      editedStart: editedOffset,
      editedEnd: editedOffset + duration
    });

    editedOffset += duration;
  }

  return editedSegments;
}

export function findSegmentIndex(segments: EditedSegment[], timeSec: number): number {
  if (segments.length === 0) {
    return -1;
  }

  for (const [index, segment] of segments.entries()) {
    if (timeSec >= segment.editedStart && timeSec < segment.editedEnd) {
      return index;
    }
  }

  return segments.length - 1;
}

export function snapTimelineValueToTargets(
  valueSec: number,
  targetsSec: number[],
  railWidthPx: number,
  timelineDurationSec: number
): number {
  if (!Number.isFinite(valueSec) || railWidthPx <= 0 || timelineDurationSec <= 0) {
    return valueSec;
  }

  const thresholdSec =
    (TIMELINE_SNAP_THRESHOLD_PX / Math.max(1, railWidthPx)) * timelineDurationSec;

  let nearest = valueSec;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const target of targetsSec) {
    if (!Number.isFinite(target)) {
      continue;
    }
    const distance = Math.abs(valueSec - target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = target;
    }
  }

  return nearestDistance <= thresholdSec ? nearest : valueSec;
}

export function moveTimelineItem(
  items: TimelineItem[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean
): TimelineItem[] {
  if (draggedId === targetId) {
    return items;
  }

  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  let insertIndex = next.findIndex((item) => item.id === targetId);
  if (insertIndex < 0) {
    return items;
  }

  if (placeAfter) {
    insertIndex += 1;
  }

  next.splice(insertIndex, 0, dragged);
  return next;
}
