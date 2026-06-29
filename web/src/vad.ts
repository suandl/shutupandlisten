// Microphone audio source: Web Audio capture → Silero VAD → smart-turn EOU.
//
// Translates the live mic into the InputEvent stream the pure detector consumes:
// speech-start / speech-end from Silero VAD (@ricky0123/vad-web, ONNX Runtime
// Web / WASM), and an `eou` verdict from smart-turn run on each completed speech
// segment. All on CPU/WASM in workers — the main thread stays glitch-free and
// the GPU is untouched (reserved for the LLM/TTS in later units).
//
// The detector is fed identically whether events come from here or the
// simulator, so the same tested timing logic runs in both.

import type { InputEvent } from './turn-detection.ts';
import type { VadKnobs } from './knobs.ts';
import { createSmartTurn, type SmartTurn } from './smart-turn.ts';

export interface AudioSource {
  readonly kind: 'mic' | 'sim';
  /** Human-readable status for the UI (which models are live). */
  readonly info: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent: (e: InputEvent) => void;
}

export interface MicOptions {
  now: () => number;
  vadKnobs: VadKnobs;
  smartTurnModelUrl?: string;
}

const VAD_SAMPLE_RATE = 16000;

export class MicAudioSource implements AudioSource {
  readonly kind = 'mic' as const;
  onEvent: (e: InputEvent) => void = () => {};

  private readonly now: () => number;
  private readonly vadKnobs: VadKnobs;
  private readonly modelUrl?: string;
  private vad: { start: () => void; pause: () => void; destroy?: () => void } | null = null;
  private smartTurn: SmartTurn | null = null;
  private _info = 'microphone (not started)';

  constructor(opts: MicOptions) {
    this.now = opts.now;
    this.vadKnobs = opts.vadKnobs;
    this.modelUrl = opts.smartTurnModelUrl;
  }

  get info(): string {
    return this._info;
  }

  async start(): Promise<void> {
    // Dynamic imports so a missing model lib / no-mic environment fails softly
    // at start() rather than breaking the whole page load.
    const { MicVAD } = await import('@ricky0123/vad-web');
    this.smartTurn = await createSmartTurn({ modelUrl: this.modelUrl });

    this.vad = await MicVAD.new({
      positiveSpeechThreshold: this.vadKnobs.positiveSpeechThreshold,
      negativeSpeechThreshold: this.vadKnobs.negativeSpeechThreshold,
      redemptionFrames: this.vadKnobs.redemptionFrames,
      minSpeechFrames: this.vadKnobs.minSpeechFrames,
      onSpeechStart: () => {
        this.onEvent({ t: this.now(), type: 'speech-start' });
      },
      onSpeechEnd: (audio: Float32Array) => {
        // Emit speech-end immediately; smart-turn resolves a beat later (≈12ms)
        // and lands its verdict inside the silence floor, exactly as the spec
        // assumes.
        this.onEvent({ t: this.now(), type: 'speech-end' });
        void this.classify(audio);
      },
      onVADMisfire: () => {
        // Sub-min-speech blip — not a real utterance; ignore.
      },
    });
    this.vad.start();
    this._info = `Silero VAD + smart-turn (${this.smartTurn.mode})`;
  }

  private async classify(audio: Float32Array): Promise<void> {
    if (!this.smartTurn) return;
    const { completionProb } = await this.smartTurn.predict(audio, VAD_SAMPLE_RATE);
    this.onEvent({ t: this.now(), type: 'eou', completionProb });
  }

  async stop(): Promise<void> {
    this.vad?.pause();
    this.vad?.destroy?.();
    this.vad = null;
    this._info = 'microphone (stopped)';
  }
}
