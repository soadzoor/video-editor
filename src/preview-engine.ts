import {
  DataStream,
  Endianness,
  MP4BoxBuffer,
  createFile,
  type ISOFile,
  type Movie,
  type Sample,
  type Track
} from "mp4box";

export interface PreviewClip {
  id: string;
  file: File;
  width: number;
  height: number;
}

export interface PreviewSegment {
  id: string;
  timelineItemId?: string;
  clipId: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  scale: number;
  panX: number;
  panY: number;
  editedStart: number;
  editedEnd: number;
}

export interface PreviewEngineCallbacks {
  onTimeUpdate?: (editedTimeSec: number) => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
}

interface DemuxedVideoSample {
  ctsSec: number;
  durationSec: number;
  isKeyframe: boolean;
  data: Uint8Array<ArrayBuffer>;
}

interface DemuxedClipVideo {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  samples: DemuxedVideoSample[];
  presentationTimestamps: number[];
  keyframeIndices: number[];
  description?: Uint8Array<ArrayBuffer>;
}

interface QueuedFrame {
  timestampSec: number;
  frame: VideoFrame;
}

interface ClipRuntime {
  clip: PreviewClip;
  demuxPromise?: Promise<DemuxedClipVideo>;
  demuxed?: DemuxedClipVideo;
  audioDecodePromise?: Promise<AudioBuffer | null>;
  audioBuffer?: AudioBuffer | null;
  decoder?: VideoDecoder;
  decoderGeneration: number;
  decodeCursor: number;
  frameQueue: QueuedFrame[];
  lastTargetSourceSec: number;
  lastDrawnTimestampSec: number;
  forceNextChunkAsKey: boolean;
}

const PREVIEW_EPSILON = 0.0001;
const SEGMENT_EDGE_EPSILON = 0.001;
const MAX_DECODED_QUEUE_SIZE = 24;
const MAX_IN_FLIGHT_DECODE_CHUNKS = 24;
const SEEK_BACKWARD_RESET_THRESHOLD_SEC = 0.25;
const LOOKAHEAD_SECONDS = 0.35;
const SEEK_DECODER_WAIT_MS = 220;
const PLAYBACK_DECODER_WAIT_MS = 8;
const SEEK_RENDER_RETRY_COUNT = 3;
const SEEK_RENDER_RETRY_DELAY_MS = 16;
const PLAYBACK_POST_SEEK_HOLD_MS = 260;
const PLAYBACK_POST_SEEK_HOLD_WINDOW_MS = 1500;
const DEMUX_TIMEOUT_MS = 15000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= PREVIEW_EPSILON;
}

function clampPreviewScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1000, Math.max(0.001, value));
}

function sanitizePan(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function findSegmentIndex(segments: PreviewSegment[], timeSec: number): number {
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

function resolveSegmentAt(
  segments: PreviewSegment[],
  editedTimeSec: number
): { segment: PreviewSegment; sourceTimeSec: number; index: number } | null {
  if (segments.length === 0) {
    return null;
  }

  const bounded = clamp(editedTimeSec, 0, Math.max(0, segments[segments.length - 1].editedEnd));
  const segmentIndex = Math.max(0, findSegmentIndex(segments, bounded));
  const segment = segments[segmentIndex];

  const sourceTime =
    segment.sourceStart + (bounded - segment.editedStart) * Math.max(PREVIEW_EPSILON, segment.speed);
  return {
    segment,
    sourceTimeSec: clamp(sourceTime, segment.sourceStart, Math.max(segment.sourceStart, segment.sourceEnd)),
    index: segmentIndex
  };
}

function extractDecoderDescription(track: Track, mp4File: ISOFile<void, void>): Uint8Array<ArrayBuffer> | undefined {
  const trackBox = mp4File.getTrackById(track.id);
  const stsdEntries = trackBox.mdia.minf.stbl.stsd.entries;
  const entry = stsdEntries[0] as
    | {
        avcC?: { write: (stream: DataStream) => void };
        hvcC?: { write: (stream: DataStream) => void };
        vpcC?: { write: (stream: DataStream) => void };
        av1C?: { write: (stream: DataStream) => void };
      }
    | undefined;

  if (!entry) {
    return undefined;
  }

  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  if (!box) {
    return undefined;
  }

  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  const boxBytes = new Uint8Array(stream.buffer, 0, stream.byteLength);
  if (boxBytes.byteLength <= 8) {
    return undefined;
  }

  return boxBytes.slice(8);
}

function extractLengthPrefixedNalSize(track: Track, mp4File: ISOFile<void, void>): number | undefined {
  const trackBox = mp4File.getTrackById(track.id);
  const stsdEntries = trackBox.mdia.minf.stbl.stsd.entries;
  const entry = stsdEntries[0] as
    | {
        avcC?: { lengthSizeMinusOne?: number };
        hvcC?: { lengthSizeMinusOne?: number };
      }
    | undefined;

  if (!entry) {
    return undefined;
  }

  const avcLen = entry.avcC?.lengthSizeMinusOne;
  if (typeof avcLen === "number" && avcLen >= 0) {
    return avcLen + 1;
  }

  const hevcLen = entry.hvcC?.lengthSizeMinusOne;
  if (typeof hevcLen === "number" && hevcLen >= 0) {
    return hevcLen + 1;
  }

  return undefined;
}

function readBigEndianLength(bytes: Uint8Array<ArrayBuffer>, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    value = (value << 8) | bytes[offset + i];
  }
  return value >>> 0;
}

function looksLikeKeyframeByNal(
  codec: string,
  sampleData: Uint8Array<ArrayBuffer>,
  nalLengthSize: number
): boolean {
  if (nalLengthSize < 1 || nalLengthSize > 4) {
    return false;
  }

  const isAvc = codec.startsWith("avc1") || codec.startsWith("avc3");
  const isHevc =
    codec.startsWith("hvc1") ||
    codec.startsWith("hev1") ||
    codec.startsWith("hvc2") ||
    codec.startsWith("hev2");
  if (!isAvc && !isHevc) {
    return false;
  }

  let offset = 0;
  while (offset + nalLengthSize < sampleData.byteLength) {
    const nalLength = readBigEndianLength(sampleData, offset, nalLengthSize);
    offset += nalLengthSize;
    if (nalLength <= 0 || offset + nalLength > sampleData.byteLength) {
      break;
    }

    const firstNalByte = sampleData[offset];
    if (isAvc) {
      const nalType = firstNalByte & 0x1f;
      if (nalType === 5) {
        return true;
      }
    } else {
      const nalType = (firstNalByte >> 1) & 0x3f;
      if (nalType === 19 || nalType === 20 || nalType === 21) {
        return true;
      }
    }

    offset += nalLength;
  }

  return false;
}

async function demuxVideoTrack(file: File): Promise<DemuxedClipVideo> {
  const inputBuffer = await file.arrayBuffer();
  const mp4File = createFile() as ISOFile<void, void>;

  // MP4 metadata atoms can include non-ASCII 4CCs (e.g. \xA9enc). mp4box treats these as
  // invalid and aborts parse. We normalize only 4-char identifiers to keep parsing alive.
  const stream = mp4File.stream as unknown as {
    readString: (length: number, encoding?: string) => string;
  };
  const originalReadString = stream.readString.bind(stream);
  stream.readString = (length: number, encoding?: string): string => {
    const value = originalReadString(length, encoding);
    if (length !== 4 || value.length !== 4) {
      return value;
    }

    let changed = false;
    let normalized = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) {
        normalized += "_";
        changed = true;
      } else {
        normalized += value[i];
      }
    }
    return changed ? normalized : value;
  };

  return new Promise((resolve, reject) => {
    let videoTrack: Track | null = null;
    let nalLengthSize: number | undefined;
    let trackId = -1;
    let expectedSamples = 0;
    let finished = false;
    const samples: DemuxedVideoSample[] = [];
    const parserErrors: string[] = [];

    const timeoutId = globalThis.setTimeout(() => {
      if (finished) {
        return;
      }
      if (videoTrack && samples.length > 0) {
        complete();
        return;
      }
      const details =
        parserErrors.length > 0
          ? ` Last parser error: ${parserErrors[parserErrors.length - 1]}`
          : "";
      fail(`Timed out while parsing video track.${details}`);
    }, DEMUX_TIMEOUT_MS);

    const fail = (reason: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      globalThis.clearTimeout(timeoutId);
      try {
        mp4File.stop();
      } catch {
        // no-op
      }
      reject(new Error(reason));
    };

    const complete = (): void => {
      if (finished || !videoTrack) {
        return;
      }
      finished = true;
      globalThis.clearTimeout(timeoutId);
      try {
        mp4File.stop();
      } catch {
        // no-op
      }

      const keyframeIndices: number[] = [];
      for (const [index, sample] of samples.entries()) {
        if (sample.isKeyframe) {
          keyframeIndices.push(index);
        }
      }
      if (keyframeIndices.length === 0 && samples.length > 0) {
        keyframeIndices.push(0);
      }

      if (samples.length > 0) {
        let minCts = samples[0].ctsSec;
        for (let i = 1; i < samples.length; i += 1) {
          if (samples[i].ctsSec < minCts) {
            minCts = samples[i].ctsSec;
          }
        }
        if (minCts > PREVIEW_EPSILON) {
          for (const sample of samples) {
            sample.ctsSec = Math.max(0, sample.ctsSec - minCts);
          }
        }
      }

      let trackDurationSec = videoTrack.duration / Math.max(1, videoTrack.timescale);
      if (samples.length > 0) {
        trackDurationSec = 0;
        for (const sample of samples) {
          trackDurationSec = Math.max(trackDurationSec, sample.ctsSec + sample.durationSec);
        }
      }

      const presentationTimestamps = samples
        .map((sample) => sample.ctsSec)
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
      const uniquePresentationTimestamps: number[] = [];
      for (const timestamp of presentationTimestamps) {
        const previous = uniquePresentationTimestamps[uniquePresentationTimestamps.length - 1];
        if (
          previous === undefined ||
          Math.abs(timestamp - previous) > PREVIEW_EPSILON
        ) {
          uniquePresentationTimestamps.push(timestamp);
        }
      }

      resolve({
        codec: videoTrack.codec,
        width: videoTrack.video?.width ?? videoTrack.track_width,
        height: videoTrack.video?.height ?? videoTrack.track_height,
        durationSec: Math.max(0, trackDurationSec),
        samples,
        presentationTimestamps: uniquePresentationTimestamps,
        keyframeIndices,
        description: extractDecoderDescription(videoTrack, mp4File)
      });
    };

    mp4File.onError = (module, message) => {
      parserErrors.push(`${module}: ${message}`);

      if (module === "BoxParser" && message.startsWith("Invalid box type:")) {
        return;
      }

      if (
        module === "ISOFile" &&
        message.includes("Invalid data found while parsing box") &&
        videoTrack &&
        samples.length > 0
      ) {
        complete();
      }
    };

    mp4File.onReady = (info: Movie) => {
      videoTrack = info.videoTracks[0] ?? null;
      if (!videoTrack) {
        fail("No video track found in source file.");
        return;
      }

      nalLengthSize = extractLengthPrefixedNalSize(videoTrack, mp4File);

      trackId = videoTrack.id;
      expectedSamples = Math.max(0, videoTrack.nb_samples);
      mp4File.setExtractionOptions(trackId, undefined, { nbSamples: 256 });
      mp4File.start();

      if (expectedSamples === 0) {
        complete();
      }
    };

    mp4File.onSamples = (id, _user, incomingSamples: Sample[]) => {
      if (!videoTrack || id !== trackId) {
        return;
      }

      for (const sample of incomingSamples) {
        if (!sample.data || sample.data.byteLength === 0) {
          continue;
        }

        const copied = new Uint8Array(sample.data.byteLength);
        copied.set(sample.data);

        const declaredSync = sample.is_sync || sample.depends_on === 2;
        const nalDetectedSync =
          !declaredSync &&
          typeof nalLengthSize === "number" &&
          looksLikeKeyframeByNal(videoTrack.codec, copied, nalLengthSize);

        samples.push({
          ctsSec: sample.cts / Math.max(1, sample.timescale),
          durationSec: sample.duration / Math.max(1, sample.timescale),
          isKeyframe: declaredSync || nalDetectedSync,
          data: copied
        });
      }

      const lastSample = incomingSamples[incomingSamples.length - 1];
      if (lastSample) {
        mp4File.releaseUsedSamples(trackId, lastSample.number);
      }

      if (samples.length >= expectedSamples) {
        complete();
      }
    };

    const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(inputBuffer, 0);
    mp4File.appendBuffer(mp4Buffer, true);
    mp4File.flush();
  });
}

async function decodeAudioBuffer(file: File, audioContext: AudioContext): Promise<AudioBuffer | null> {
  try {
    const copy = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(copy.slice(0));
    return audioBuffer;
  } catch {
    return null;
  }
}

export class TimelinePreviewEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: PreviewEngineCallbacks;

  private clips = new Map<string, ClipRuntime>();
  private segments: PreviewSegment[] = [];

  private durationSec = 0;
  private editedTimeSec = 0;

  private isPlaying = false;
  private rafId: number | null = null;
  private playAnchorEditedSec = 0;
  private playAnchorPerfMs = 0;

  private renderLoopPromise: Promise<void> | null = null;
  private pendingRenderRequest: { editedTimeSec: number; isSeek: boolean } | null = null;
  private seekRenderRequestId = 0;
  private lastRenderOutcome: { editedTimeSec: number; isSeek: boolean; drewFrame: boolean } | null =
    null;
  private lastSeekPerfMs = Number.NEGATIVE_INFINITY;
  private playbackClockHoldActive = false;
  private playbackClockHoldUntilMs = 0;

  private audioContext: AudioContext | null = null;
  private audioGainNode: GainNode | null = null;
  private activeAudioNode: AudioBufferSourceNode | null = null;
  private activeAudioSegmentId: string | null = null;
  private audioSyncGeneration = 0;

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: PreviewEngineCallbacks = {}
  ) {
    this.canvas = canvas;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    this.ctx = context;
    this.callbacks = callbacks;

    this.paintBlackFrame();
  }

  public async setProject(
    clips: PreviewClip[],
    segments: PreviewSegment[],
    editedPositionSec: number,
    workspaceResolution?: { width: number; height: number }
  ): Promise<void> {
    const clipIds = new Set(clips.map((clip) => clip.id));

    for (const [clipId, state] of this.clips.entries()) {
      if (clipIds.has(clipId)) {
        continue;
      }
      this.cleanupClipState(state);
      this.clips.delete(clipId);
    }

    for (const clip of clips) {
      const existing = this.clips.get(clip.id);
      if (existing) {
        existing.clip = clip;
        continue;
      }

      this.clips.set(clip.id, {
        clip,
        decoderGeneration: 0,
        decodeCursor: 0,
        frameQueue: [],
        lastTargetSourceSec: 0,
        lastDrawnTimestampSec: Number.NEGATIVE_INFINITY,
        forceNextChunkAsKey: false
      });
    }

    this.segments = [...segments].sort((a, b) => a.editedStart - b.editedStart);
    this.durationSec = this.segments.length > 0 ? this.segments[this.segments.length - 1].editedEnd : 0;
    this.updateCanvasResolution(clips, workspaceResolution);

    if (this.durationSec <= 0 || this.segments.length === 0) {
      this.pause();
      this.setEditedTime(0);
      this.paintBlackFrame();
      return;
    }

    const bounded = clamp(editedPositionSec, 0, this.durationSec);
    this.setEditedTime(bounded);

    for (const segment of this.segments) {
      void this.ensureDemuxedClip(segment.clipId);
    }

    await this.renderSeekWithRetry(this.editedTimeSec);

    if (this.isPlaying) {
      await this.syncAudioToCurrentPosition();
    }
  }

  public updateTimelineItemTransform(
    timelineItemId: string,
    nextTransform: { scale?: number; panX?: number; panY?: number }
  ): void {
    if (!timelineItemId || this.segments.length === 0) {
      return;
    }

    const nextScale =
      nextTransform.scale === undefined ? undefined : clampPreviewScale(nextTransform.scale);
    const nextPanX =
      nextTransform.panX === undefined ? undefined : sanitizePan(nextTransform.panX);
    const nextPanY =
      nextTransform.panY === undefined ? undefined : sanitizePan(nextTransform.panY);

    let hasChanged = false;
    for (const segment of this.segments) {
      if (segment.timelineItemId !== timelineItemId) {
        continue;
      }

      const scale = nextScale === undefined ? segment.scale : nextScale;
      const panX = nextPanX === undefined ? segment.panX : nextPanX;
      const panY = nextPanY === undefined ? segment.panY : nextPanY;
      if (
        nearlyEqual(scale, segment.scale) &&
        nearlyEqual(panX, segment.panX) &&
        nearlyEqual(panY, segment.panY)
      ) {
        continue;
      }

      segment.scale = scale;
      segment.panX = panX;
      segment.panY = panY;
      hasChanged = true;
    }

    if (!hasChanged) {
      return;
    }

    const drewFrame = this.redrawCurrentFrameWithoutDecode();
    if (drewFrame) {
      this.lastRenderOutcome = {
        editedTimeSec: this.editedTimeSec,
        isSeek: true,
        drewFrame: true
      };
      return;
    }

    void this.requestRender(this.editedTimeSec, true);
  }

  public getPositionSec(): number {
    return this.editedTimeSec;
  }

  public getDurationSec(): number {
    return this.durationSec;
  }

  public seek(editedTimeSec: number): void {
    this.lastSeekPerfMs = performance.now();
    const bounded = clamp(editedTimeSec, 0, this.durationSec);
    this.setEditedTime(bounded);

    if (this.isPlaying) {
      this.playAnchorEditedSec = bounded;
      this.playAnchorPerfMs = performance.now();
      void this.syncAudioToCurrentPosition();
      void this.requestRender(bounded, true);
      return;
    }

    void this.renderSeekWithRetry(bounded);
  }

  public async seekAndRender(editedTimeSec: number): Promise<void> {
    this.lastSeekPerfMs = performance.now();
    const bounded = clamp(editedTimeSec, 0, this.durationSec);
    this.setEditedTime(bounded);

    if (this.isPlaying) {
      this.playAnchorEditedSec = bounded;
      this.playAnchorPerfMs = performance.now();
      await this.requestRender(bounded, true);
      return;
    }

    await this.renderSeekWithRetry(bounded);
  }

  public async stepFrame(direction: -1 | 1): Promise<number> {
    if (this.durationSec <= 0 || this.segments.length === 0) {
      return this.editedTimeSec;
    }

    const targetEditedTime = await this.findFrameStepTargetEditedTime(direction);
    if (targetEditedTime === null || nearlyEqual(targetEditedTime, this.editedTimeSec)) {
      return this.editedTimeSec;
    }

    await this.seekAndRender(targetEditedTime);
    return this.editedTimeSec;
  }

  public async play(): Promise<void> {
    if (this.isPlaying || this.durationSec <= 0 || this.segments.length === 0) {
      return;
    }

    if (this.editedTimeSec >= this.durationSec - SEGMENT_EDGE_EPSILON) {
      this.setEditedTime(0);
    }

    // Warm the frame at the current position before starting the wall-clock
    // playback anchor. This prevents a short perceived fast-forward period
    // immediately after manual seeks.
    await this.renderSeekWithRetry(this.editedTimeSec);

    this.isPlaying = true;
    this.playAnchorEditedSec = this.editedTimeSec;
    this.playAnchorPerfMs = performance.now();
    this.playbackClockHoldActive = this.shouldHoldClockAfterSeek(this.playAnchorPerfMs);
    this.playbackClockHoldUntilMs = this.playbackClockHoldActive
      ? this.playAnchorPerfMs + PLAYBACK_POST_SEEK_HOLD_MS
      : 0;
    this.callbacks.onPlayStateChange?.(true);

    await this.ensureAudioContext();
    if (!this.playbackClockHoldActive) {
      await this.syncAudioToCurrentPosition();
    }

    this.rafId = window.requestAnimationFrame(this.onAnimationFrame);
  }

  public pause(): void {
    if (!this.isPlaying) {
      return;
    }

    this.isPlaying = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.stopActiveAudioNode();
    this.activeAudioSegmentId = null;
    this.audioSyncGeneration += 1;
    this.playbackClockHoldActive = false;
    this.playbackClockHoldUntilMs = 0;
    this.callbacks.onPlayStateChange?.(false);
  }

  public destroy(): void {
    this.pause();

    for (const state of this.clips.values()) {
      this.cleanupClipState(state);
    }
    this.clips.clear();

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
      this.audioGainNode = null;
    }
  }

  private readonly onAnimationFrame = (nowMs: number): void => {
    if (!this.isPlaying) {
      return;
    }

    if (this.playbackClockHoldActive) {
      void this.requestRender(this.editedTimeSec, true);

      const outcome = this.lastRenderOutcome;
      const holdFrameReady =
        outcome !== null &&
        outcome.isSeek &&
        outcome.drewFrame &&
        nearlyEqual(outcome.editedTimeSec, this.editedTimeSec);
      const holdExpired = nowMs >= this.playbackClockHoldUntilMs;

      if (holdFrameReady || holdExpired) {
        this.playbackClockHoldActive = false;
        this.playbackClockHoldUntilMs = 0;
        this.playAnchorEditedSec = this.editedTimeSec;
        this.playAnchorPerfMs = nowMs;
        void this.syncAudioToCurrentPosition();
      }

      this.rafId = window.requestAnimationFrame(this.onAnimationFrame);
      return;
    }

    const elapsedSec = Math.max(0, (nowMs - this.playAnchorPerfMs) / 1000);
    const nextTime = this.playAnchorEditedSec + elapsedSec;

    if (nextTime >= this.durationSec - SEGMENT_EDGE_EPSILON) {
      this.setEditedTime(this.durationSec);
      void this.requestRender(this.durationSec, false);
      this.pause();
      return;
    }

    this.setEditedTime(nextTime);

    const resolved = resolveSegmentAt(this.segments, this.editedTimeSec);
    if (resolved && resolved.segment.id !== this.activeAudioSegmentId) {
      void this.syncAudioToCurrentPosition();
    }

    void this.requestRender(this.editedTimeSec, false);
    this.rafId = window.requestAnimationFrame(this.onAnimationFrame);
  };

  private setEditedTime(nextTimeSec: number): void {
    const bounded = clamp(nextTimeSec, 0, this.durationSec);
    if (nearlyEqual(this.editedTimeSec, bounded)) {
      this.editedTimeSec = bounded;
      return;
    }

    this.editedTimeSec = bounded;
    this.callbacks.onTimeUpdate?.(bounded);
  }

  private shouldHoldClockAfterSeek(nowMs: number): boolean {
    if (!Number.isFinite(this.lastSeekPerfMs)) {
      return false;
    }
    const elapsedSinceSeekMs = nowMs - this.lastSeekPerfMs;
    return elapsedSinceSeekMs >= 0 && elapsedSinceSeekMs <= PLAYBACK_POST_SEEK_HOLD_WINDOW_MS;
  }

  private editedTimeFromSourceTime(segment: PreviewSegment, sourceTimeSec: number): number {
    const boundedSource = clamp(
      sourceTimeSec,
      segment.sourceStart,
      Math.max(segment.sourceStart, segment.sourceEnd - PREVIEW_EPSILON)
    );
    const speed = Math.max(PREVIEW_EPSILON, segment.speed);
    const edited = segment.editedStart + (boundedSource - segment.sourceStart) / speed;
    return clamp(
      edited,
      segment.editedStart,
      Math.max(segment.editedStart, segment.editedEnd - PREVIEW_EPSILON)
    );
  }

  private findFirstTimestampAtOrAfter(
    timestamps: number[],
    minTargetSec: number,
    segmentSourceMin: number,
    segmentSourceMax: number
  ): number | null {
    for (const cts of timestamps) {
      if (cts < segmentSourceMin) {
        continue;
      }
      if (cts > segmentSourceMax) {
        break;
      }
      if (cts >= minTargetSec) {
        return cts;
      }
    }
    return null;
  }

  private findLastTimestampAtOrBefore(
    timestamps: number[],
    maxTargetSec: number,
    segmentSourceMin: number,
    segmentSourceMax: number
  ): number | null {
    for (let index = timestamps.length - 1; index >= 0; index -= 1) {
      const cts = timestamps[index];
      if (cts > segmentSourceMax) {
        continue;
      }
      if (cts < segmentSourceMin) {
        break;
      }
      if (cts <= maxTargetSec) {
        return cts;
      }
    }
    return null;
  }

  private async findFrameStepTargetEditedTime(direction: -1 | 1): Promise<number | null> {
    const resolved = resolveSegmentAt(this.segments, this.editedTimeSec);
    if (!resolved) {
      return null;
    }

    if (direction > 0) {
      for (let segmentIndex = resolved.index; segmentIndex < this.segments.length; segmentIndex += 1) {
        const segment = this.segments[segmentIndex];
        const segmentSourceMin = segment.sourceStart;
        const segmentSourceMax = Math.max(segment.sourceStart, segment.sourceEnd - PREVIEW_EPSILON);
        const clipState = await this.ensureDemuxedClip(segment.clipId);
        const presentationTimestamps = clipState.demuxed?.presentationTimestamps ?? [];

        const minTargetSec =
          segmentIndex === resolved.index
            ? Math.max(segmentSourceMin, resolved.sourceTimeSec + PREVIEW_EPSILON)
            : segmentSourceMin;

        const sourceTarget =
          presentationTimestamps.length > 0
            ? this.findFirstTimestampAtOrAfter(
                presentationTimestamps,
                minTargetSec,
                segmentSourceMin,
                segmentSourceMax
              )
            : null;

        if (sourceTarget !== null) {
          return this.editedTimeFromSourceTime(segment, sourceTarget);
        }
      }
      return this.editedTimeSec;
    }

    for (let segmentIndex = resolved.index; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = this.segments[segmentIndex];
      const segmentSourceMin = segment.sourceStart;
      const segmentSourceMax = Math.max(segment.sourceStart, segment.sourceEnd - PREVIEW_EPSILON);
      const clipState = await this.ensureDemuxedClip(segment.clipId);
      const presentationTimestamps = clipState.demuxed?.presentationTimestamps ?? [];

      const maxTargetSec =
        segmentIndex === resolved.index
          ? Math.min(segmentSourceMax, resolved.sourceTimeSec - PREVIEW_EPSILON)
          : segmentSourceMax;

      const sourceTarget =
        presentationTimestamps.length > 0
          ? this.findLastTimestampAtOrBefore(
              presentationTimestamps,
              maxTargetSec,
              segmentSourceMin,
              segmentSourceMax
            )
          : null;

      if (sourceTarget !== null) {
        return this.editedTimeFromSourceTime(segment, sourceTarget);
      }
    }

    return this.editedTimeSec;
  }

  private async renderSeekWithRetry(editedTimeSec: number): Promise<void> {
    const requestId = ++this.seekRenderRequestId;

    for (let attempt = 0; attempt <= SEEK_RENDER_RETRY_COUNT; attempt += 1) {
      await this.requestRender(editedTimeSec, true);

      if (requestId !== this.seekRenderRequestId) {
        return;
      }

      const outcome = this.lastRenderOutcome;
      if (
        outcome &&
        outcome.isSeek &&
        outcome.drewFrame &&
        nearlyEqual(outcome.editedTimeSec, editedTimeSec)
      ) {
        return;
      }

      if (attempt >= SEEK_RENDER_RETRY_COUNT) {
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, SEEK_RENDER_RETRY_DELAY_MS);
      });
    }
  }

  private updateCanvasResolution(
    clips: PreviewClip[],
    workspaceResolution?: { width: number; height: number }
  ): void {
    let width = 1280;
    let height = 720;

    if (
      workspaceResolution &&
      Number.isFinite(workspaceResolution.width) &&
      Number.isFinite(workspaceResolution.height) &&
      workspaceResolution.width >= 2 &&
      workspaceResolution.height >= 2
    ) {
      width = Math.max(2, Math.round(workspaceResolution.width));
      height = Math.max(2, Math.round(workspaceResolution.height));
    } else if (clips.length > 0) {
      let bestArea = 0;
      for (const clip of clips) {
        const area = Math.max(1, clip.width) * Math.max(1, clip.height);
        if (area > bestArea) {
          bestArea = area;
          width = Math.max(2, Math.round(clip.width));
          height = Math.max(2, Math.round(clip.height));
        }
      }
    }

    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.paintBlackFrame();
  }

  private paintBlackFrame(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private async ensureDemuxedClip(clipId: string): Promise<ClipRuntime> {
    const state = this.clips.get(clipId);
    if (!state) {
      throw new Error("A clip referenced by the timeline is missing.");
    }

    if (state.demuxed) {
      return state;
    }

    if (!state.demuxPromise) {
      state.demuxPromise = demuxVideoTrack(state.clip.file).then((demuxed) => {
        state.demuxed = demuxed;
        return demuxed;
      });
    }

    try {
      await state.demuxPromise;
      return state;
    } catch (error) {
      state.demuxPromise = undefined;
      throw error;
    }
  }

  private createDecoder(state: ClipRuntime): VideoDecoder {
    if (!state.demuxed) {
      throw new Error("Clip decoder cannot be created before demux.");
    }

    const config: VideoDecoderConfig = {
      codec: state.demuxed.codec,
      codedWidth: Math.max(1, state.demuxed.width),
      codedHeight: Math.max(1, state.demuxed.height),
      description: state.demuxed.description
    };

    const generation = state.decoderGeneration;

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (generation !== state.decoderGeneration) {
          frame.close();
          return;
        }

        const timestampSec = frame.timestamp / 1_000_000;
        const queuedFrame: QueuedFrame = { timestampSec, frame };
        let insertIndex = state.frameQueue.length;
        while (
          insertIndex > 0 &&
          state.frameQueue[insertIndex - 1].timestampSec > queuedFrame.timestampSec
        ) {
          insertIndex -= 1;
        }
        if (insertIndex === state.frameQueue.length) {
          state.frameQueue.push(queuedFrame);
        } else {
          state.frameQueue.splice(insertIndex, 0, queuedFrame);
        }

        while (state.frameQueue.length > MAX_DECODED_QUEUE_SIZE) {
          const dropped = state.frameQueue.shift();
          dropped?.frame.close();
        }
      },
      error: (error: DOMException) => {
        this.callbacks.onError?.(`Video decoder error: ${error.message}`);
      }
    });

    decoder.configure(config);
    return decoder;
  }

  private clearFrameQueue(state: ClipRuntime): void {
    for (const queued of state.frameQueue) {
      queued.frame.close();
    }
    state.frameQueue = [];
  }

  private resetDecoderForSourceTime(state: ClipRuntime, sourceTimeSec: number): void {
    state.decoderGeneration += 1;

    if (state.decoder) {
      try {
        state.decoder.close();
      } catch {
        // no-op
      }
      state.decoder = undefined;
    }

    this.clearFrameQueue(state);

    if (!state.demuxed || state.demuxed.samples.length === 0) {
      state.decodeCursor = 0;
      state.lastTargetSourceSec = sourceTimeSec;
      state.lastDrawnTimestampSec = Number.NEGATIVE_INFINITY;
      state.forceNextChunkAsKey = false;
      return;
    }

    const sampleIndex = this.findSampleIndexAtOrBefore(state.demuxed.samples, sourceTimeSec);

    let keyframeSampleIndex = 0;
    for (const keyframeIndex of state.demuxed.keyframeIndices) {
      if (keyframeIndex > sampleIndex) {
        break;
      }
      keyframeSampleIndex = keyframeIndex;
    }

    state.decodeCursor = keyframeSampleIndex;
    state.lastTargetSourceSec = sourceTimeSec;
    state.lastDrawnTimestampSec = Number.NEGATIVE_INFINITY;
    state.forceNextChunkAsKey = true;
    state.decoder = this.createDecoder(state);
  }

  private findSampleIndexAtOrBefore(samples: DemuxedVideoSample[], targetTimeSec: number): number {
    if (samples.length === 0) {
      return 0;
    }
    if (samples.length === 1) {
      return 0;
    }

    let bestIndex = -1;
    let bestCts = Number.NEGATIVE_INFINITY;
    let minCts = Number.POSITIVE_INFINITY;
    let minCtsIndex = 0;

    for (let i = 0; i < samples.length; i += 1) {
      const cts = samples[i].ctsSec;
      if (cts < minCts) {
        minCts = cts;
        minCtsIndex = i;
      }
      if (cts <= targetTimeSec + PREVIEW_EPSILON && cts >= bestCts) {
        bestCts = cts;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      return bestIndex;
    }
    return minCtsIndex;
  }

  private async decodeTowardSourceTime(
    state: ClipRuntime,
    sourceTimeSec: number,
    isSeek: boolean
  ): Promise<void> {
    if (!state.demuxed || state.demuxed.samples.length === 0) {
      return;
    }

    const hasBufferedFrames = state.frameQueue.length > 0;
    const queueFirstTime = state.frameQueue[0]?.timestampSec ?? Number.POSITIVE_INFINITY;
    const queueLastTime =
      state.frameQueue[state.frameQueue.length - 1]?.timestampSec ?? Number.NEGATIVE_INFINITY;
    const movedBackward = sourceTimeSec + PREVIEW_EPSILON < state.lastTargetSourceSec;
    const movedBackwardBy = state.lastTargetSourceSec - sourceTimeSec;

    if (isSeek) {
      const seekedOutsideBufferedRange =
        hasBufferedFrames &&
        (sourceTimeSec + PREVIEW_EPSILON < queueFirstTime ||
          sourceTimeSec - PREVIEW_EPSILON > queueLastTime);
      const movedBackwardFarWithoutBufferedCoverage =
        !hasBufferedFrames && movedBackwardBy > SEEK_BACKWARD_RESET_THRESHOLD_SEC && movedBackward;
      if (!state.decoder || seekedOutsideBufferedRange || movedBackwardFarWithoutBufferedCoverage) {
        this.resetDecoderForSourceTime(state, sourceTimeSec);
      }
    } else {
      if (!state.decoder) {
        this.resetDecoderForSourceTime(state, sourceTimeSec);
      }

      const seekedBeforeBufferedRange =
        hasBufferedFrames && sourceTimeSec + PREVIEW_EPSILON < queueFirstTime;
      if (seekedBeforeBufferedRange) {
        this.resetDecoderForSourceTime(state, sourceTimeSec);
      } else if (movedBackwardBy > SEEK_BACKWARD_RESET_THRESHOLD_SEC && movedBackward) {
        this.resetDecoderForSourceTime(state, sourceTimeSec);
      }
    }

    if (!state.decoder) {
      this.resetDecoderForSourceTime(state, sourceTimeSec);
    }
    if (!state.decoder || !state.demuxed) {
      return;
    }

    const samples = state.demuxed.samples;
    const lookahead = isSeek ? LOOKAHEAD_SECONDS * 1.5 : LOOKAHEAD_SECONDS;
    const wantedUntilSec = sourceTimeSec + lookahead;
    const waitBudgetMs = isSeek ? SEEK_DECODER_WAIT_MS : PLAYBACK_DECODER_WAIT_MS;

    let fedUntilSec = state.frameQueue[state.frameQueue.length - 1]?.timestampSec ?? -1;
    if (state.decodeCursor > 0 && fedUntilSec < 0) {
      const previous = samples[Math.min(samples.length - 1, state.decodeCursor - 1)];
      fedUntilSec = previous.ctsSec + previous.durationSec;
    }
    const queueLengthBeforeDecode = state.frameQueue.length;
    let fedAny = false;

    while (
      state.decodeCursor < samples.length &&
      fedUntilSec < wantedUntilSec
    ) {
      if (state.decoder.decodeQueueSize >= MAX_IN_FLIGHT_DECODE_CHUNKS) {
        if (!isSeek) {
          break;
        }
        const queueLengthBeforeWait = state.frameQueue.length;
        await this.waitForDecoderOutput(state, queueLengthBeforeWait, waitBudgetMs);
        if (
          state.decoder.decodeQueueSize >= MAX_IN_FLIGHT_DECODE_CHUNKS &&
          state.frameQueue.length === queueLengthBeforeWait
        ) {
          break;
        }
        continue;
      }

      const sample = samples[state.decodeCursor];
      state.decodeCursor += 1;

      const chunk = new EncodedVideoChunk({
        type: sample.isKeyframe || state.forceNextChunkAsKey ? "key" : "delta",
        timestamp: Math.max(0, Math.round(sample.ctsSec * 1_000_000)),
        duration: Math.max(1, Math.round(sample.durationSec * 1_000_000)),
        data: sample.data
      });

      state.decoder.decode(chunk);
      state.forceNextChunkAsKey = false;
      fedAny = true;
      fedUntilSec = Math.max(fedUntilSec, sample.ctsSec + sample.durationSec);
    }

    if (isSeek && fedAny && state.frameQueue.length <= queueLengthBeforeDecode) {
      await this.waitForDecoderOutput(state, queueLengthBeforeDecode, waitBudgetMs);
    }

    if (isSeek) {
      const seekDeadlineMs = performance.now() + waitBudgetMs;
      while (performance.now() < seekDeadlineMs) {
        let hasFrameAtOrBeforeTarget = false;
        for (const queued of state.frameQueue) {
          if (queued.timestampSec <= sourceTimeSec + PREVIEW_EPSILON) {
            hasFrameAtOrBeforeTarget = true;
            break;
          }
        }
        if (hasFrameAtOrBeforeTarget) {
          break;
        }

        if (state.decoder.decodeQueueSize <= 0) {
          break;
        }

        const queueLengthBeforeWait = state.frameQueue.length;
        const remainingWaitMs = Math.max(1, seekDeadlineMs - performance.now());
        await this.waitForDecoderOutput(state, queueLengthBeforeWait, remainingWaitMs);
        if (
          state.frameQueue.length <= queueLengthBeforeWait &&
          state.decoder.decodeQueueSize <= 0
        ) {
          break;
        }
      }
    }

    state.lastTargetSourceSec = sourceTimeSec;
  }

  private async waitForDecoderOutput(
    state: ClipRuntime,
    previousQueueLength: number,
    maxWaitMs: number
  ): Promise<void> {
    const decoder = state.decoder;
    if (!decoder) {
      return;
    }

    const startMs = performance.now();
    while (performance.now() - startMs < maxWaitMs) {
      if (state.frameQueue.length > previousQueueLength) {
        return;
      }
      if (decoder.decodeQueueSize === 0) {
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    }
  }

  private drawQueuedFrame(
    state: ClipRuntime,
    segment: PreviewSegment,
    sourceTimeSec: number,
    isSeek: boolean
  ): boolean {
    if (state.frameQueue.length === 0) {
      return false;
    }

    const minAllowedTimestamp = isSeek
      ? Number.NEGATIVE_INFINITY
      : state.lastDrawnTimestampSec - PREVIEW_EPSILON;

    let targetIndex = -1;
    for (let i = 0; i < state.frameQueue.length; i += 1) {
      const timestamp = state.frameQueue[i].timestampSec;
      if (timestamp > sourceTimeSec + PREVIEW_EPSILON) {
        break;
      }
      if (timestamp >= minAllowedTimestamp) {
        targetIndex = i;
      }
    }

    if (targetIndex < 0) {
      if (isSeek) {
        const firstFrame = state.frameQueue[0];
        if (!firstFrame) {
          return false;
        }
        // During seeks, wait for a better frame while decode is still in
        // flight. Fallback to first frame only when decode is drained.
        if (
          firstFrame.timestampSec > sourceTimeSec + PREVIEW_EPSILON &&
          (state.decoder?.decodeQueueSize ?? 0) > 0
        ) {
          return false;
        }
        targetIndex = 0;
      } else {
        // Keep the previously drawn frame until a newer frame arrives.
        return true;
      }
    }

    const queuedFrame = state.frameQueue[targetIndex];
    const frame = queuedFrame.frame;
    this.drawFrameWithTransform(frame, segment);

    if (targetIndex > 0 && !isSeek) {
      const staleFrames = state.frameQueue.splice(0, targetIndex);
      for (const stale of staleFrames) {
        stale.frame.close();
      }
    }

    if (isSeek) {
      state.lastDrawnTimestampSec = queuedFrame.timestampSec;
    } else {
      state.lastDrawnTimestampSec = Math.max(
        state.lastDrawnTimestampSec,
        queuedFrame.timestampSec
      );
    }

    return true;
  }

  private drawFrameWithTransform(frame: VideoFrame, segment: PreviewSegment): void {
    const frameWidth = frame.displayWidth || frame.codedWidth;
    const frameHeight = frame.displayHeight || frame.codedHeight;

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (frameWidth <= 0 || frameHeight <= 0) {
      return;
    }

    const containScale = Math.min(canvasWidth / frameWidth, canvasHeight / frameHeight);
    const baseWidth = frameWidth * containScale;
    const baseHeight = frameHeight * containScale;
    const transformScale = clampPreviewScale(segment.scale);
    const drawWidth = baseWidth * transformScale;
    const drawHeight = baseHeight * transformScale;
    const x = (canvasWidth - drawWidth) / 2 + sanitizePan(segment.panX);
    const y = (canvasHeight - drawHeight) / 2 + sanitizePan(segment.panY);
    this.ctx.drawImage(frame, x, y, drawWidth, drawHeight);
  }

  private pickFrameForTransformRedraw(
    state: ClipRuntime,
    sourceTimeSec: number
  ): QueuedFrame | null {
    if (state.frameQueue.length === 0) {
      return null;
    }

    if (Number.isFinite(state.lastDrawnTimestampSec)) {
      let best: QueuedFrame | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const queued of state.frameQueue) {
        const distance = Math.abs(queued.timestampSec - state.lastDrawnTimestampSec);
        if (distance >= bestDistance) {
          continue;
        }
        best = queued;
        bestDistance = distance;
        if (distance <= PREVIEW_EPSILON) {
          break;
        }
      }
      if (best) {
        return best;
      }
    }

    let atOrBeforeTarget: QueuedFrame | null = null;
    for (const queued of state.frameQueue) {
      if (queued.timestampSec > sourceTimeSec + PREVIEW_EPSILON) {
        break;
      }
      atOrBeforeTarget = queued;
    }
    return atOrBeforeTarget ?? state.frameQueue[0] ?? null;
  }

  private requestRender(editedTimeSec: number, isSeek: boolean): Promise<void> {
    const existing = this.pendingRenderRequest;
    this.pendingRenderRequest = {
      editedTimeSec,
      isSeek: (existing?.isSeek ?? false) || isSeek
    };

    if (!this.renderLoopPromise) {
      this.renderLoopPromise = this.drainRenderRequests();
    }

    return this.renderLoopPromise;
  }

  private async drainRenderRequests(): Promise<void> {
    while (this.pendingRenderRequest) {
      const request = this.pendingRenderRequest;
      this.pendingRenderRequest = null;

      try {
        const drewFrame = await this.renderEditedTime(request.editedTimeSec, request.isSeek);
        this.lastRenderOutcome = {
          editedTimeSec: request.editedTimeSec,
          isSeek: request.isSeek,
          drewFrame
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Preview rendering failed.";
        this.callbacks.onError?.(message);
      }
    }
    this.renderLoopPromise = null;
  }

  private async renderEditedTime(editedTimeSec: number, isSeek: boolean): Promise<boolean> {
    const resolved = resolveSegmentAt(this.segments, editedTimeSec);
    if (!resolved) {
      this.paintBlackFrame();
      return false;
    }

    const { segment, sourceTimeSec } = resolved;
    const state = await this.ensureDemuxedClip(segment.clipId);

    await this.decodeTowardSourceTime(
      state,
      clamp(
        sourceTimeSec,
        segment.sourceStart,
        Math.max(segment.sourceStart, segment.sourceEnd - PREVIEW_EPSILON)
      ),
      isSeek
    );

    const drew = this.drawQueuedFrame(state, segment, sourceTimeSec, isSeek);
    return drew;
  }

  private redrawCurrentFrameWithoutDecode(): boolean {
    const resolved = resolveSegmentAt(this.segments, this.editedTimeSec);
    if (!resolved) {
      this.paintBlackFrame();
      return false;
    }

    const state = this.clips.get(resolved.segment.clipId);
    if (!state || state.frameQueue.length === 0) {
      return false;
    }

    const boundedSourceTime = clamp(
      resolved.sourceTimeSec,
      resolved.segment.sourceStart,
      Math.max(resolved.segment.sourceStart, resolved.segment.sourceEnd - PREVIEW_EPSILON)
    );
    const queuedFrame = this.pickFrameForTransformRedraw(state, boundedSourceTime);
    if (!queuedFrame) {
      return false;
    }

    this.drawFrameWithTransform(queuedFrame.frame, resolved.segment);
    state.lastDrawnTimestampSec = queuedFrame.timestampSec;
    return true;
  }

  private async ensureAudioContext(): Promise<void> {
    if (typeof window === "undefined") {
      return;
    }

    if (!this.audioContext) {
      const AudioContextCtor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextCtor) {
        return;
      }

      const context = new AudioContextCtor();
      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(context.destination);

      this.audioContext = context;
      this.audioGainNode = gain;
    }

    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        // no-op
      }
    }
  }

  private stopActiveAudioNode(): void {
    if (!this.activeAudioNode) {
      return;
    }

    try {
      this.activeAudioNode.stop();
    } catch {
      // no-op
    }

    this.activeAudioNode.disconnect();
    this.activeAudioNode = null;
  }

  private async getAudioBufferForClip(state: ClipRuntime): Promise<AudioBuffer | null> {
    if (!this.audioContext) {
      return null;
    }

    if (state.audioBuffer !== undefined) {
      return state.audioBuffer;
    }

    if (!state.audioDecodePromise) {
      state.audioDecodePromise = decodeAudioBuffer(state.clip.file, this.audioContext).then((buffer) => {
        state.audioBuffer = buffer;
        return buffer;
      });
    }

    const buffer = await state.audioDecodePromise;
    return buffer;
  }

  private async syncAudioToCurrentPosition(): Promise<void> {
    if (!this.isPlaying || !this.audioContext || !this.audioGainNode) {
      return;
    }

    const generation = ++this.audioSyncGeneration;
    this.stopActiveAudioNode();

    const resolved = resolveSegmentAt(this.segments, this.editedTimeSec);
    if (!resolved) {
      this.activeAudioSegmentId = null;
      return;
    }

    const { segment, sourceTimeSec } = resolved;
    this.activeAudioSegmentId = segment.id;

    try {
      const clipState = await this.ensureDemuxedClip(segment.clipId);
      const audioBuffer = await this.getAudioBufferForClip(clipState);

      if (
        generation !== this.audioSyncGeneration ||
        !this.isPlaying ||
        !this.audioContext ||
        !this.audioGainNode
      ) {
        return;
      }

      if (!audioBuffer) {
        return;
      }

      const boundedSourceTime = clamp(sourceTimeSec, 0, Math.max(0, audioBuffer.duration - PREVIEW_EPSILON));
      const segmentSourceEnd = Math.min(segment.sourceEnd, audioBuffer.duration);
      const remainingSourceSec = segmentSourceEnd - boundedSourceTime;
      if (remainingSourceSec <= PREVIEW_EPSILON) {
        return;
      }

      const sourceNode = this.audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      try {
        sourceNode.playbackRate.value = Math.max(PREVIEW_EPSILON, segment.speed);
      } catch {
        sourceNode.playbackRate.value = 1;
      }
      sourceNode.connect(this.audioGainNode);

      sourceNode.onended = () => {
        if (this.activeAudioNode === sourceNode && generation === this.audioSyncGeneration) {
          this.activeAudioNode = null;
        }
      };

      if (generation !== this.audioSyncGeneration || !this.isPlaying) {
        sourceNode.disconnect();
        return;
      }

      const startAt = this.audioContext.currentTime + 0.02;
      sourceNode.start(startAt, boundedSourceTime, remainingSourceSec);
      this.activeAudioNode = sourceNode;
    } catch {
      // Silent fallback when audio decode/schedule fails.
    }
  }

  private cleanupClipState(state: ClipRuntime): void {
    this.clearFrameQueue(state);

    if (state.decoder) {
      try {
        state.decoder.close();
      } catch {
        // no-op
      }
      state.decoder = undefined;
    }

    state.demuxPromise = undefined;
    state.demuxed = undefined;
    state.audioDecodePromise = undefined;
    state.audioBuffer = undefined;
  }
}
