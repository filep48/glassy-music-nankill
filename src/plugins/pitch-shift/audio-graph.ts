import {
  insertLineNode,
  registerMediaSource,
  removeLineNode,
} from '@/utils/audio-line';

import workletSource from './pitch-worklet.js?raw';

const PROCESSOR_NAME = 'pitch-shift-processor';
const LINE_NODE_ID = 'pitch-shift';

/**
 * The worklet ships as an inlined string rather than an emitted chunk: the renderer
 * builds as a single IIFE, so there is no stable URL to hand `addModule`. The Blob
 * URL survives because the app strips CSP from every https: response (index.ts).
 */
const addWorkletModule = async (audioContext: AudioContext) => {
  const url = URL.createObjectURL(
    new Blob([workletSource], { type: 'application/javascript' }),
  );
  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * Owns the pitch node's place in the shared audio line (`@/utils/audio-line`).
 *
 * The node has to replace the dry path, not sit beside it: a parallel branch would
 * play the shifted and unshifted audio at once. The line splices it in series with
 * whatever crossfade and smooth-transitions have inserted, which wiring
 * `source → node → destination` by hand could not do.
 */
export class PitchAudioGraph {
  lastSource: MediaElementAudioSourceNode | null = null;
  lastContext: AudioContext | null = null;

  private node: AudioWorkletNode | null = null;
  private semitones = 0;
  private phaseLocking = true;
  private flushHeld = false;

  private connected = new WeakMap<
    MediaElementAudioSourceNode,
    AudioWorkletNode
  >();
  private moduleLoads = new WeakMap<AudioContext, Promise<void>>();
  /** Serialises attach calls, so back-to-back track changes cannot interleave. */
  private pending: Promise<boolean> = Promise.resolve(false);

  get isAttached() {
    return this.node !== null;
  }

  attach(
    source: MediaElementAudioSourceNode | null,
    audioContext: AudioContext | null,
  ): Promise<boolean> {
    // A rejection here would poison the chain and block every later attach, so the
    // failure is absorbed: the direct source → destination line keeps playing.
    this.pending = this.pending.then(() =>
      this.attachNow(source, audioContext).catch((error: unknown) => {
        console.error('[pitch-shift] attach failed', error);
        return false;
      }),
    );
    return this.pending;
  }

  private async attachNow(
    source: MediaElementAudioSourceNode | null,
    audioContext: AudioContext | null,
  ): Promise<boolean> {
    if (!(source && audioContext)) return false;

    this.lastSource = source;
    this.lastContext = audioContext;

    // Same track re-announced, or a new track on the same graph — nothing to rewire,
    // but the buffers hold pre-seek audio that would burst out on resume.
    const current = this.connected.get(source);
    if (current && current === this.node) {
      this.flush();
      return true;
    }

    registerMediaSource(source.mediaElement as HTMLVideoElement, source);

    let node: AudioWorkletNode;
    try {
      let load = this.moduleLoads.get(audioContext);
      if (!load) {
        load = addWorkletModule(audioContext);
        this.moduleLoads.set(audioContext, load);
      }
      await load;

      node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        // Pinned to stereo so a mono track cannot change the channel count
        // mid-stream, which would reset the vocoder's buffers with a click.
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        outputChannelCount: [2],
      });
    } catch (error) {
      // A failed load must leave the untouched direct line playing.
      console.error('[pitch-shift] could not create the worklet node', error);
      this.moduleLoads.delete(audioContext);
      return false;
    }

    this.node = node;
    this.applySemitones();
    this.setPhaseLocking(this.phaseLocking);

    if (!insertLineNode(audioContext, source, LINE_NODE_ID, node)) {
      console.error('[pitch-shift] could not insert the worklet node');
      this.node = null;
      return false;
    }
    this.connected.set(source, node);
    return true;
  }

  detach(): boolean {
    const source = this.lastSource;
    const audioContext = this.lastContext;
    if (!(source && audioContext)) return false;
    if (!this.connected.has(source)) return false;

    if (!removeLineNode(audioContext, source, LINE_NODE_ID)) return false;
    this.connected.delete(source);
    this.node = null;
    return true;
  }

  setSemitones(value: number) {
    this.semitones = value;
    this.applySemitones();
  }

  private applySemitones() {
    const param = this.node?.parameters.get('pitchSemitones');
    // The worklet glides internally, so a bare assignment is enough — no ramp needed.
    if (param) param.value = this.semitones;
  }

  setPhaseLocking(enabled: boolean) {
    this.phaseLocking = enabled;
    this.node?.port.postMessage({ type: 'phaseLocking', value: enabled });
  }

  /** Drop buffered audio. Required on seek and track change. */
  flush() {
    if (this.flushHeld) return;
    this.node?.port.postMessage({ type: 'flush' });
  }

  /**
   * While crossfade's gapless bridge plays, it feeds this node with the player held
   * silent upstream, so a flush would cut the bridge rather than stale player audio.
   */
  holdFlushes(held: boolean) {
    this.flushHeld = held;
  }
}
