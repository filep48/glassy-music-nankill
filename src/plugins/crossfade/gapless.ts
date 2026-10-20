import {
  getLineNodeOutput,
  insertLineNode,
  registerMediaSource,
  removeLineNode,
} from '@/utils/audio-line';

import type { GetState, QueueItem } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';

const LINE_NODE_ID = 'crossfade-gapless';
const PRELOAD_AFTER_S = 3;
const SCHEDULE_BEFORE_END_S = 1.5;
const BRIDGE_SECONDS = 16;
const BOUNDARY_RAMP_S = 0.005;
const HANDOVER_RAMP_S = 0.03;
const ALIGN_TOLERANCE_S = 0.003;
const ALIGN_ATTEMPTS = 5;
const SEEK_LIMIT_S = 0.35;
const NUDGE = 0.1;
const ALIGN_SETTLE_S = 0.75;
const BRIDGE_HEADROOM_S = 1;
const TAP_SIZE = 32768;
const MAX_LAG_S = 0.3;

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type Deps = {
  playerApi: MusicPlayer;
  getAudioUrl: (videoId: string) => Promise<string | null>;
  log: Log;
};

type Bridge = {
  fromId: string | null;
  videoId: string;
  buffer: AudioBuffer;
  node: AudioBufferSourceNode;
  gain: GainNode;
  tap: AnalyserNode;
  startAt: number;
  rate: number;
  preservesPitch: boolean;
};

const rendererOf = (item: QueueItem | undefined) =>
  item?.playlistPanelVideoRenderer ??
  item?.playlistPanelVideoWrapperRenderer?.primaryRenderer
    ?.playlistPanelVideoRenderer;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const announceBridge = (active: boolean) =>
  document.dispatchEvent(
    new CustomEvent('peard:audio-bridge', { detail: { active } }),
  );

/**
 * Lag (seconds) of `b` behind `a`, from the peak of their cross-correlation.
 * Searched on a 4x decimated copy first, then refined at full rate.
 */
const measureLag = (
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
): { lag: number; score: number } => {
  const decimate = (x: Float32Array) => {
    const out = new Float32Array(Math.floor(x.length / 4));
    for (let i = 0; i < out.length; i++) {
      const at = i * 4;
      out[i] = (x[at] + x[at + 1] + x[at + 2] + x[at + 3]) / 4;
    }
    return out;
  };
  const correlate = (
    x: Float32Array,
    y: Float32Array,
    from: number,
    to: number,
  ) => {
    let best = from;
    let bestScore = -Infinity;
    for (let lag = from; lag <= to; lag++) {
      let sum = 0;
      let ex = 0;
      let ey = 0;
      for (
        let i = Math.max(0, lag);
        i < Math.min(x.length, y.length + lag);
        i++
      ) {
        const xi = x[i];
        const yi = y[i - lag];
        sum += xi * yi;
        ex += xi * xi;
        ey += yi * yi;
      }
      const score = sum / (Math.sqrt(ex * ey) || 1);
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    return { lag: best, score: bestScore };
  };

  // Lags past half the window compare a handful of samples, which correlate
  // perfectly by accident.
  const maxLag = Math.floor(Math.min(MAX_LAG_S * sampleRate, a.length / 2) / 4);
  const coarse = correlate(decimate(a), decimate(b), -maxLag, maxLag);
  const center = coarse.lag * 4;
  const fine = correlate(a, b, center - 8, center + 8);
  return { lag: fine.lag / sampleRate, score: fine.score };
};

/**
 * Plays the next queue item back to back with the current one.
 *
 * The player only starts loading the next track once the current one has
 * ended, which leaves a silent gap. Instead, the first seconds of the next
 * track are decoded ahead of time and started on the AudioContext clock at
 * the exact end of the current one. Once the player has loaded the new track
 * it is seeked to match, aligned by cross-correlating the two signals, and
 * given the audio back.
 *
 * The bridge joins the shared line right after this module's own gain, so it
 * goes through every node downstream (pitch-shift, smooth-transitions) while
 * the player's path is held silent.
 */
export class GaplessEngine {
  private readonly deps: Deps;
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private element: HTMLVideoElement | null = null;
  private lineGain: GainNode | null = null;
  private videoTap: AnalyserNode | null = null;
  private sink: GainNode | null = null;

  private trackId: string | null = null;
  private preloaded: { videoId: string; buffer: AudioBuffer } | null = null;
  private preloadFor: string | null = null;
  private bridge: Bridge | null = null;
  private aligning = false;
  private ownSeek = false;
  private stopWatch: (() => void) | null = null;
  private boundaryLead = 0.02;
  private seekStall = 0.14;
  private disposed = false;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  start(): boolean {
    const bus = window.__blyricsAudio;
    if (!bus) {
      this.deps.log.warn('[Gapless] No shared audio bus; gapless disabled.');
      return false;
    }
    this.context = bus.context;
    this.source = bus.source;
    this.element = bus.element;
    registerMediaSource(bus.element, bus.source);

    this.lineGain = this.context.createGain();
    if (
      !insertLineNode(this.context, this.source, LINE_NODE_ID, this.lineGain, {
        first: true,
      })
    ) {
      this.deps.log.warn('[Gapless] Could not join the audio line.');
      return false;
    }

    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.context.destination);
    this.videoTap = this.context.createAnalyser();
    this.videoTap.fftSize = TAP_SIZE;
    this.source.connect(this.videoTap);
    this.videoTap.connect(this.sink);

    this.element.addEventListener('timeupdate', this.onTimeUpdate);
    this.element.addEventListener('seeking', this.onSeeking);
    this.element.addEventListener('pause', this.onPause);
    this.element.addEventListener('playing', this.onPlaying);
    this.deps.log.info('[Gapless] Ready.');
    return true;
  }

  dispose() {
    this.disposed = true;
    this.element?.removeEventListener('timeupdate', this.onTimeUpdate);
    this.element?.removeEventListener('seeking', this.onSeeking);
    this.element?.removeEventListener('pause', this.onPause);
    this.element?.removeEventListener('playing', this.onPlaying);
    this.dropBridge();
    if (this.context && this.source) {
      removeLineNode(this.context, this.source, LINE_NODE_ID);
      try {
        this.source.disconnect(this.videoTap!);
      } catch {
        // already detached
      }
    }
    this.sink?.disconnect();
  }

  private currentVideoId(): string | null {
    try {
      return this.deps.playerApi.getVideoData()?.video_id ?? null;
    } catch {
      return null;
    }
  }

  private nextVideoId(): string | null {
    const bar = document.querySelector<
      HTMLElement & { getState?: () => GetState }
    >('ytmusic-player-bar');
    const queue = bar?.getState?.()?.queue;
    if (!queue || queue.repeatMode === 'ONE') return null;
    const index = queue.items.findIndex((item) => rendererOf(item)?.selected);
    if (index === -1) return null;
    const next =
      queue.items[index + 1] ??
      (queue.repeatMode === 'ALL' ? queue.items[0] : undefined);
    return rendererOf(next)?.videoId ?? null;
  }

  private async preload(videoId: string) {
    const context = this.context!;
    const url = await this.deps.getAudioUrl(videoId);
    if (!url) {
      this.deps.log.warn(`[Gapless] No audio URL for ${videoId}.`);
      return;
    }
    const params = new URL(url).searchParams;
    const length = Number(params.get('clen'));
    const duration = Number(params.get('dur'));
    const bytesPerSecond =
      length > 0 && duration > 0 ? length / duration : 32_000;
    const bridgeBytes = bytesPerSecond * BRIDGE_SECONDS;
    const wanted = Math.ceil(64_000 + bridgeBytes);
    const lastByte = Math.min(length > 0 ? length : Infinity, wanted) - 1;

    const response = await fetch(url, {
      headers: { Range: `bytes=0-${lastByte}` },
    });
    if (!response.ok) {
      this.deps.log.warn(
        `[Gapless] Preload of ${videoId} failed with HTTP ${response.status}.`,
      );
      return;
    }
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    if (this.disposed || this.preloadFor !== videoId) return;
    this.preloaded = { videoId, buffer };
    this.deps.log.info(
      `[Gapless] Preloaded ${videoId}: ${buffer.duration.toFixed(1)}s decoded.`,
    );
  }

  private readonly onTimeUpdate = () => {
    const video = this.element;
    if (!video || this.disposed) return;

    const id = this.currentVideoId();
    if (id !== this.trackId) {
      this.trackId = id;
      if (!this.bridge) {
        this.preloaded = null;
        this.preloadFor = null;
      }
    }

    if (this.bridge) {
      const started = this.context!.currentTime >= this.bridge.startAt;
      if (!started && id !== this.bridge.fromId) {
        this.deps.log.info(
          '[Gapless] Track changed before the bridge started.',
        );
        this.abortBridge();
        return;
      }
      if (id === this.bridge.videoId && !video.paused && !this.aligning) {
        this.handOver().catch((error: unknown) => {
          this.deps.log.warn(`[Gapless] Handover failed: ${String(error)}`);
          this.abortBridge();
        });
      } else if (
        id &&
        id !== this.bridge.videoId &&
        id !== this.bridge.fromId
      ) {
        this.deps.log.warn(
          `[Gapless] Player moved to ${id}, not the bridged ${this.bridge.videoId}; giving the audio back.`,
        );
        this.abortBridge();
      }
      return;
    }

    if (video.paused || !Number.isFinite(video.duration)) return;

    if (video.currentTime > PRELOAD_AFTER_S && this.preloadFor === null) {
      const next = this.nextVideoId();
      if (next && next !== id) {
        this.preloadFor = next;
        this.preload(next).catch((error: unknown) => {
          this.deps.log.warn(
            `[Gapless] Preload of ${next} failed: ${String(error)}`,
          );
        });
      }
    }

    const remaining = (video.duration - video.currentTime) / video.playbackRate;
    if (
      remaining <= SCHEDULE_BEFORE_END_S &&
      remaining > 0.05 &&
      this.preloaded &&
      this.preloaded.videoId === this.nextVideoId()
    ) {
      this.scheduleBridge(remaining);
    }
  };

  private scheduleBridge(remaining: number) {
    const context = this.context!;
    const video = this.element!;
    const preloaded = this.preloaded!;
    this.preloaded = null;

    const entry = getLineNodeOutput(context, this.source!, LINE_NODE_ID);
    if (!entry) return;

    const startAt = context.currentTime + remaining - this.boundaryLead;
    const node = context.createBufferSource();
    node.buffer = preloaded.buffer;
    node.playbackRate.value = video.playbackRate;
    if (video.preservesPitch && video.playbackRate !== 1) {
      this.deps.log.warn(
        '[Gapless] Speed is not 1 with pitch preserved; the bridge will play at a shifted pitch.',
      );
    }

    const gain = context.createGain();
    const volume = video.muted ? 0 : video.volume;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + BOUNDARY_RAMP_S);
    node.connect(gain);
    gain.connect(entry);

    const tap = context.createAnalyser();
    tap.fftSize = TAP_SIZE;
    node.connect(tap);
    tap.connect(this.sink!);

    const line = this.lineGain!.gain;
    line.cancelScheduledValues(context.currentTime);
    line.setValueAtTime(1, startAt);
    line.linearRampToValueAtTime(0, startAt + BOUNDARY_RAMP_S);

    node.start(startAt);
    announceBridge(true);
    this.watchBoundary(startAt);
    this.bridge = {
      fromId: this.trackId,
      videoId: preloaded.videoId,
      buffer: preloaded.buffer,
      node,
      gain,
      tap,
      startAt,
      rate: video.playbackRate,
      preservesPitch: video.preservesPitch,
    };
    this.deps.log.info(
      `[Gapless] Bridge for ${preloaded.videoId} scheduled in ${remaining.toFixed(3)}s (lead ${(this.boundaryLead * 1000).toFixed(1)}ms).`,
    );
  }

  /** Logs when the player's audio actually stopped, relative to the bridge start. */
  private watchBoundary(startAt: number) {
    const context = this.context!;
    const probe = context.createAnalyser();
    probe.fftSize = 512;
    this.source!.connect(probe);
    probe.connect(this.sink!);
    const block = new Float32Array(probe.fftSize);
    let lastSound = -1;
    const stop = () => {
      clearInterval(timer);
      this.source!.disconnect(probe);
      probe.disconnect();
      this.stopWatch = null;
    };
    this.stopWatch = stop;
    const timer = setInterval(() => {
      probe.getFloatTimeDomainData(block);
      let peak = 0;
      for (let i = block.length - 240; i < block.length; i++) {
        peak = Math.max(peak, Math.abs(block[i]));
      }
      if (peak > 1e-4) lastSound = context.currentTime;
      if (context.currentTime < startAt + 0.4) return;
      stop();
      if (lastSound < 0) return;
      const delta = lastSound - startAt;
      this.deps.log.info(
        `[Gapless] Player audio stopped ${Math.abs(delta * 1000).toFixed(0)}ms ${delta < 0 ? 'BEFORE (gap)' : 'after (overlap)'} the bridge start.`,
      );
      // Longer readings are a quiet ending fading out, not a late start.
      if (Math.abs(delta) < 0.04) {
        const correction = delta * 0.7;
        const lead = this.boundaryLead - correction;
        this.boundaryLead = Math.min(Math.max(lead, 0), 0.15);
      }
    }, 5);
  }

  private bridgePosition() {
    const bridge = this.bridge!;
    return (this.context!.currentTime - bridge.startAt) * bridge.rate;
  }

  /** Resolves once the tap holds only audio played after this call. */
  private async waitProgress(video: HTMLVideoElement) {
    const from = video.currentTime;
    for (let waited = 0; waited < 3000; waited += 20) {
      if (video.currentTime - from >= ALIGN_SETTLE_S) return;
      await sleep(20);
    }
  }

  private async seekVideo(video: HTMLVideoElement, time: number) {
    this.ownSeek = true;
    video.currentTime = Math.max(0, time);
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      setTimeout(done, 1500);
    });
  }

  /**
   * Moves the muted player by `offset` seconds without seeking: a seek stalls
   * playback for a varying 100-200 ms, while the media clock follows the playback
   * rate exactly.
   */
  private async nudge(video: HTMLVideoElement, offset: number) {
    const base = this.bridge!.rate;
    video.playbackRate = base * (offset < 0 ? 1 + NUDGE : 1 - NUDGE);
    await sleep((Math.abs(offset) / (base * NUDGE)) * 1000);
    video.playbackRate = base;
  }

  /** Player position minus bridge position, in content seconds. */
  private measureOffset() {
    const bridge = this.bridge!;
    const a = new Float32Array(TAP_SIZE);
    const b = new Float32Array(TAP_SIZE);
    bridge.tap.getFloatTimeDomainData(a);
    this.videoTap!.getFloatTimeDomainData(b);
    const { lag, score } = measureLag(a, b, this.context!.sampleRate);
    return { offset: lag * bridge.rate, score };
  }

  private async handOver() {
    const video = this.element!;
    const context = this.context!;
    this.aligning = true;

    // The player resets the rate when it loads a track, and playback-speed is
    // told to stand back while the bridge plays.
    video.playbackRate = this.bridge!.rate;
    video.preservesPitch = this.bridge!.preservesPitch;

    let aligned = false;
    let seekTarget: number | null = this.bridgePosition() + this.seekStall;
    await this.seekVideo(video, seekTarget);
    await this.waitProgress(video);

    for (let attempt = 1; attempt <= ALIGN_ATTEMPTS; attempt++) {
      if (!this.bridge || this.disposed) return;
      if (
        this.bridgePosition() >
        this.bridge.buffer.duration - BRIDGE_HEADROOM_S
      ) {
        this.deps.log.warn('[Gapless] Bridge ran out before alignment.');
        break;
      }

      const { offset, score } = this.measureOffset();
      this.deps.log.info(
        `[Gapless] Align ${attempt}: player ${offset >= 0 ? 'ahead' : 'behind'} by ${Math.abs(offset * 1000).toFixed(1)}ms (score ${score.toFixed(2)}).`,
      );
      if (score < 0.5) {
        this.deps.log.warn('[Gapless] Signals do not match; not aligning.');
        break;
      }
      if (seekTarget !== null) {
        const stall = this.seekStall - offset;
        this.seekStall = Math.min(Math.max(stall, 0), 0.4);
        seekTarget = null;
      }
      if (Math.abs(offset) <= ALIGN_TOLERANCE_S) {
        aligned = true;
        break;
      }
      if (Math.abs(offset) > SEEK_LIMIT_S) {
        seekTarget = this.bridgePosition() + this.seekStall;
        await this.seekVideo(video, seekTarget);
      } else {
        await this.nudge(video, offset);
      }
      await this.waitProgress(video);
    }

    if (!this.bridge) return;
    const at = context.currentTime + 0.01;
    this.bridge.gain.gain.cancelScheduledValues(at);
    this.bridge.gain.gain.setValueAtTime(this.bridge.gain.gain.value, at);
    this.bridge.gain.gain.linearRampToValueAtTime(0, at + HANDOVER_RAMP_S);
    const line = this.lineGain!.gain;
    line.cancelScheduledValues(at);
    line.setValueAtTime(0, at);
    line.linearRampToValueAtTime(1, at + HANDOVER_RAMP_S);
    this.deps.log.info(
      `[Gapless] Handed over to the player ${aligned ? 'aligned' : 'UNALIGNED'}.`,
    );
    const bridge = this.bridge;
    this.bridge = null;
    this.aligning = false;
    this.preloaded = null;
    this.preloadFor = null;
    setTimeout(
      () => this.releaseBridge(bridge),
      (HANDOVER_RAMP_S + 0.1) * 1000,
    );
  }

  private abortBridge() {
    const context = this.context!;
    const at = context.currentTime;
    const line = this.lineGain!.gain;
    line.cancelScheduledValues(at);
    line.setValueAtTime(1, at);
    this.dropBridge();
    this.preloaded = null;
    this.preloadFor = null;
  }

  private dropBridge() {
    this.stopWatch?.();
    if (!this.bridge) return;
    const bridge = this.bridge;
    this.bridge = null;
    this.aligning = false;
    this.releaseBridge(bridge);
  }

  private releaseBridge(bridge: Bridge) {
    if (!this.bridge) announceBridge(false);
    try {
      bridge.node.stop();
    } catch {
      // never started or already stopped
    }
    bridge.node.disconnect();
    bridge.gain.disconnect();
    bridge.tap.disconnect();
  }

  private readonly onSeeking = () => {
    if (this.ownSeek) {
      this.ownSeek = false;
      return;
    }
    // The player seeks on its own when it loads the next track; only a seek
    // inside the old track means the user moved away from the boundary.
    if (this.bridge && this.currentVideoId() === this.bridge.fromId) {
      this.abortBridge();
    }
  };

  private readonly onPause = () => {
    const video = this.element;
    // Reaching the end fires 'pause' before 'ended': that is the boundary
    // the bridge exists for, not the user pausing.
    if (!this.bridge || !video || video.ended) return;
    if (this.currentVideoId() === this.bridge.videoId) {
      this.ownSeek = true;
      video.currentTime = this.bridgePosition();
    }
    this.abortBridge();
  };

  private readonly onPlaying = () => {
    if (this.bridge && this.currentVideoId() === this.bridge.videoId) {
      this.onTimeUpdate();
    }
  };
}
