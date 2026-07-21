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
import { createSmartTurn, type SmartTurn, type SmartTurnOptions } from './smart-turn.ts';
import { createTranscriber, type Transcriber, type TranscriberOptions } from './stt.ts';
import { createDenoiser, type Denoiser, type DenoiserOptions } from './denoise.ts';
import type { TranscriptSegment } from './transcript.ts';

export interface AudioSource {
  readonly kind: 'mic' | 'sim';
  /** Human-readable status for the UI (which models are live). */
  readonly info: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent: (e: InputEvent) => void;
  /**
   * Additive STT channel: a transcribed speech segment, emitted twice per
   * utterance — first `pending` at speech-end, then resolved with text. Sources
   * with no audio (the simulator) never call it. This is display-only; it never
   * feeds the detector, so the tested turn-detection timing is unchanged.
   */
  onTranscript?: (seg: TranscriptSegment) => void;
}

export interface MicOptions {
  now: () => number;
  vadKnobs: VadKnobs;
  /** smart-turn EOU config (default: no model → labelled duration heuristic). */
  smartTurnOptions?: SmartTurnOptions;
  /** STT model config (default: no model → labelled stub). */
  sttOptions?: TranscriberOptions;
  /** Denoise stage config (default: no engine → passthrough, mic path unchanged). */
  denoiseOptions?: DenoiserOptions;
}

const VAD_SAMPLE_RATE = 16000;

export class MicAudioSource implements AudioSource {
  readonly kind = 'mic' as const;
  onEvent: (e: InputEvent) => void = () => {};
  onTranscript: (seg: TranscriptSegment) => void = () => {};

  private readonly now: () => number;
  private readonly vadKnobs: VadKnobs;
  private readonly smartTurnOptions: SmartTurnOptions;
  private readonly sttOptions: TranscriberOptions;
  private readonly denoiseOptions: DenoiserOptions;
  private vad: { start: () => void; pause: () => void; destroy?: () => void } | null = null;
  private smartTurn: SmartTurn | null = null;
  private transcriber: Transcriber | null = null;
  private denoiser: Denoiser | null = null;
  private segmentId = 0;
  private segmentStartT = 0;
  private _info = 'microphone (not started)';

  constructor(opts: MicOptions) {
    this.now = opts.now;
    this.vadKnobs = opts.vadKnobs;
    this.smartTurnOptions = opts.smartTurnOptions ?? {};
    this.sttOptions = opts.sttOptions ?? {};
    this.denoiseOptions = opts.denoiseOptions ?? {};
  }

  get info(): string {
    return this._info;
  }

  async start(): Promise<void> {
    // Dynamic imports so a missing model lib / no-mic environment fails softly
    // at start() rather than breaking the whole page load.
    const { MicVAD } = await import('@ricky0123/vad-web');

    // Browser APM (noiseSuppression + echoCancellation + autoGainControl) is the
    // cheapest café-noise lever — and it is ALREADY engaged. vad-web 0.0.24's
    // getUserMedia forces all three on by default, and its
    // `additionalAudioConstraints` type deliberately Omits exactly those keys
    // (real-time-vad.d.ts), so there is nothing to pass here to "enable" them:
    // they are on for every mic capture (this MicVAD is the only mic path).
    // Hence the increment-1 lever is the Silero thresholds below, live-tunable
    // via vadKnobs (seeded from ?vad* URL knobs). If light background music still
    // leaks past the browser APM, that is the trigger for the denoise stage
    // (increment 2, su-n8x) — which will need its OWN MediaStream via MicVAD's
    // `stream` option to sit a filter ahead of (or instead of) this default APM.
    //
    // On-device denoise stage AHEAD of the VAD (background-noise increment 2):
    // route the mic through a denoise AudioWorkletNode and hand the VAD the
    // DENOISED stream, so background music no longer reads as speech and the
    // silence gap reappears. Passthrough (default / ?denoise=off / un-provisioned
    // / mic-or-Web-Audio failure) yields no stream — MicVAD captures the mic
    // itself exactly as before, so the tested speech-event stream is unchanged.
    this.denoiser = await createDenoiser(this.denoiseOptions);
    const denoisedStream = this.denoiser.stream;
    this.vad = await MicVAD.new({
      ...(denoisedStream ? { stream: denoisedStream as unknown as MediaStream } : {}),
      positiveSpeechThreshold: this.vadKnobs.positiveSpeechThreshold,
      negativeSpeechThreshold: this.vadKnobs.negativeSpeechThreshold,
      redemptionFrames: this.vadKnobs.redemptionFrames,
      minSpeechFrames: this.vadKnobs.minSpeechFrames,
      onSpeechStart: () => {
        const t = this.now();
        this.segmentStartT = t; // remember where this utterance began, for transcript alignment
        this.onEvent({ t, type: 'speech-start' });
      },
      onSpeechEnd: (audio: Float32Array) => {
        // Emit speech-end immediately; smart-turn resolves a beat later and lands
        // its verdict inside the silence floor, as the spec assumes. MEASURED
        // (su-lou.10.1, headless Chromium, warmed): ~270ms for the whole verdict —
        // the log-Mel front-end plus inference — not the ~12ms this comment used to
        // claim from the model card, which is a native-CPU number. Comfortable
        // inside today's 2000ms floor; a real constraint on the 500-750ms floor
        // su-lou.10.5 is aiming for. STT runs on the SAME released segment,
        // independently — it feeds the transcript display only, never the detector.
        const t = this.now();
        this.onEvent({ t, type: 'speech-end' });
        void this.classify(audio);
        void this.transcribe(audio, this.segmentStartT, t);
      },
      onVADMisfire: () => {
        // Sub-min-speech blip — not a real utterance; ignore.
      },
    });
    // Create the STT worker only AFTER the mic + VAD are established. If mic
    // permission/setup fails above, start() throws before this line, so a
    // loaded-model STT worker is never created and cannot leak while the UI
    // reports "mic failed". transcribe() runs only after vad.start() (on real
    // speech), by which point this is set. (su-0hi #3)
    this.transcriber = await createTranscriber(this.sttOptions);
    // Same reasoning, same place: the EOU classifier now downloads ~21MB (model +
    // ONNX Runtime wasm) and warms an inference session, so a mic that never opens
    // must not pay for it — before su-lou.10.1 this loaded first, when it was a
    // no-op that returned the heuristic. classify() runs only after vad.start(),
    // and MicVAD.new() emits nothing until then, so nothing can outrun this.
    this.smartTurn = await createSmartTurn(this.smartTurnOptions);
    this.vad.start();
    this._info = `denoise (${this.denoiser.mode}) → Silero VAD + smart-turn (${this.smartTurn.mode}) + STT (${this.transcriber.mode})`;
  }

  private async classify(audio: Float32Array): Promise<void> {
    if (!this.smartTurn) return;
    const { completionProb } = await this.smartTurn.predict(audio, VAD_SAMPLE_RATE);
    this.onEvent({ t: this.now(), type: 'eou', completionProb });
  }

  private async transcribe(audio: Float32Array, startT: number, endT: number): Promise<void> {
    if (!this.transcriber) return;
    const id = this.segmentId++;
    const mode = this.transcriber.mode;
    // Show the captured segment immediately so the operator sees a turn formed;
    // fill in the words when STT resolves (replaced by id in the UI).
    this.onTranscript({ id, startT, endT, text: '', mode, pending: true });
    const result = await this.transcriber.transcribe(audio, VAD_SAMPLE_RATE);
    this.onTranscript({ id, startT, endT, text: result.text, mode: result.mode, pending: false });
  }

  async stop(): Promise<void> {
    this.vad?.pause();
    this.vad?.destroy?.();
    this.vad = null;
    this.transcriber?.close();
    this.transcriber = null;
    // Release the EOU session too — it holds an ONNX Runtime wasm heap, which would
    // otherwise leak across every mic stop/start cycle.
    this.smartTurn?.close();
    this.smartTurn = null;
    // Close the denoiser AFTER the VAD: it releases the mic tracks and the
    // AudioContext hosting the denoise worklet. Idempotent if the VAD already
    // stopped the provided stream.
    this.denoiser?.close();
    this.denoiser = null;
    this._info = 'microphone (stopped)';
  }
}
