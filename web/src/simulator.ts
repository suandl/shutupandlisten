// Simulation audio source — drives the detector from scripted VAD/EOU events so
// the harness runs live with working knobs WITHOUT a microphone or any model
// download. This is what makes "scenarios pass and the harness runs live with
// working knobs" verifiable by just opening the page: play a thinking-out-loud
// script, then drag the silence-floor knob and watch the same script end the
// turn mid-thought or hold it open.
//
// Events are authored with timestamps relative to playback start, then fed to
// the detector stamped with the real clock so deadlines fire in real time.

import type { InputEvent, Verdict } from './turn-detection.ts';
import type { AudioSource } from './vad.ts';
import type { TranscriptSegment } from './transcript.ts';

type RelEvent =
  | { t: number; type: 'speech-start' }
  // A speech-end MAY carry scripted transcription `text` — the words the mic path
  // would have produced for this segment. Present only in loop-driving DEMO_SCRIPTS;
  // the classic timing scripts omit it (pure detector timing, no transcript).
  | { t: number; type: 'speech-end'; text?: string }
  | { t: number; type: 'eou'; verdict: Verdict };

export interface SimScript {
  name: string;
  label: string;
  description: string;
  events: RelEvent[];
  /**
   * True when the script carries scripted transcripts and is meant to drive the
   * FULL warmed loop (transcript → gate → LLM → TTS → loop-metrics) deterministically
   * in sim mode — the mic-less demo substrate (su-lou.4.1). The classic timing
   * scripts leave it unset and exercise only the detector, exactly as before.
   */
  drivesLoop?: boolean;
}

// Demo scripts mirror the spec scenarios but are knob-reactive: with the live
// knobs the operator changes outcome (e.g. a 1.2s pause cuts off below the floor
// and holds above it). EOU verdicts are baked in so the asymmetric veto is
// exercised without the model.
export const SIM_SCRIPTS: SimScript[] = [
  {
    name: 'thinking-pause',
    label: 'Thinking pause',
    description:
      'Speak, pause ~1.2s mid-thought, resume, finish. Below the floor it ends mid-thought; above it, it holds. No EOU verdict — pure floor.',
    events: [
      { t: 0, type: 'speech-start' },
      { t: 1600, type: 'speech-end' },
      { t: 2800, type: 'speech-start' },
      { t: 4600, type: 'speech-end' },
      { t: 4660, type: 'eou', verdict: 'complete' },
    ],
  },
  {
    name: 'trailing-conjunction',
    label: 'Trailing conjunction (incomplete)',
    description:
      'A pause after "…and—" that smart-turn reads as incomplete. With the veto on, the extension holds the turn open; with it off (baseline), the floor decides alone.',
    events: [
      { t: 0, type: 'speech-start' },
      { t: 1500, type: 'speech-end' },
      { t: 1560, type: 'eou', verdict: 'incomplete' },
      { t: 2600, type: 'speech-start' },
      { t: 5000, type: 'speech-end' },
      { t: 5060, type: 'eou', verdict: 'complete' },
    ],
  },
  {
    name: 'clean-finish',
    label: 'Clean finish',
    description: 'One utterance, finished cleanly (complete). Ends one floor after the last word.',
    events: [
      { t: 0, type: 'speech-start' },
      { t: 2600, type: 'speech-end' },
      { t: 2660, type: 'eou', verdict: 'complete' },
    ],
  },
  {
    name: 'barge-in',
    label: 'Barge-in over response',
    description: 'Finish, let the stubbed response start, then speak over it — the response yields instantly and a fresh turn opens.',
    events: [
      { t: 0, type: 'speech-start' },
      { t: 2000, type: 'speech-end' },
      { t: 2060, type: 'eou', verdict: 'complete' },
      // a beat after the response begins (depends on the floor knob), barge in:
      { t: 5200, type: 'speech-start' },
      { t: 6800, type: 'speech-end' },
      { t: 6860, type: 'eou', verdict: 'complete' },
    ],
  },
];

// ── Loop-driving demo scenarios (su-lou.4.1) ──
//
// Unlike the timing scripts above (detector only), these carry scripted `text` on
// each speech-end — the words the mic path's STT would have produced — so playing
// one drives the FULL warmed loop deterministically WITHOUT a microphone or any
// model: transcript → response-hierarchy gate → on-device LLM → on-device TTS →
// per-stage loop-metrics. This is the mic-less demo substrate the PR-level capture
// engine records; real models degrade to the labelled stub / placeholder tone
// (su-lou.8), which is exactly why sim mode — not live mic — is the deterministic
// substrate. Timing is spaced so each turn's stubbed response finishes (floor 2s +
// response 1.5s) before the next utterance begins, so no unintended barge-in fires.

/** How long after a scripted speech-end the sim "transcription" resolves (a beat, like real STT). */
const SIM_STT_MS = 150;

export const DEMO_SCRIPTS: SimScript[] = [
  {
    name: 'u6-warmed-loop',
    label: 'U6 warmed loop (demo)',
    drivesLoop: true,
    description:
      'Three thinking-out-loud turns that drive the whole loop mic-lessly: a substantive turn earns a reflection, a short aside earns a minimal acknowledgment, and a direct question earns one brief question — each transcribed, gated, replied, and spoken, with per-stage latency measured.',
    events: [
      // Turn 1 — a substantive finished thought → response-hierarchy escalates to a reflection (LLM).
      { t: 0, type: 'speech-start' },
      {
        t: 3200,
        type: 'speech-end',
        text: "I keep circling the same migration plan and I can't tell if the incremental path is actually safer or just slower",
      },
      { t: 3260, type: 'eou', verdict: 'complete' },
      // Turn 2 — a short finished aside → minimal acknowledgment (rules-only backchannel, still spoken).
      { t: 8000, type: 'speech-start' },
      { t: 9200, type: 'speech-end', text: 'yeah, that makes sense' },
      { t: 9260, type: 'eou', verdict: 'complete' },
      // Turn 3 — a direct question → one brief follow-up question (LLM), answered in kind.
      { t: 14000, type: 'speech-start' },
      { t: 16000, type: 'speech-end', text: "do you think I'm overcomplicating this?" },
      { t: 16060, type: 'eou', verdict: 'complete' },
    ],
  },
];

/** Look up a loop-driving demo scenario by `name` (for the ?demo= URL entrypoint). */
export function findDemoScript(name: string): SimScript | undefined {
  return DEMO_SCRIPTS.find((s) => s.name === name);
}

export class SimAudioSource implements AudioSource {
  readonly kind = 'sim' as const;
  onEvent: (e: InputEvent) => void = () => {};
  // Additive scripted-transcript channel — populated only by DEMO_SCRIPTS (which
  // carry speech-end `text`); the timing scripts never call it. Wired by main.ts
  // exactly like the mic source's onTranscript.
  onTranscript: (seg: TranscriptSegment) => void = () => {};

  private readonly now: () => number;
  private segmentId = 0;
  private segStartT = 0;
  // ReturnType<typeof setTimeout> so the same code types cleanly whether the DOM
  // (number) or Node (@types/node Timeout, pulled in transitively) lib is active.
  private timers: ReturnType<typeof setTimeout>[] = [];
  private freeRunning = false;
  private _info = 'simulation (idle)';

  constructor(now: () => number) {
    this.now = now;
  }

  get info(): string {
    return this._info;
  }

  // AudioSource contract — start() is a no-op (driven by the play buttons),
  // stop() halts any running script or free-run.
  async start(): Promise<void> {
    this._info = 'simulation (ready — play a script)';
  }

  async stop(): Promise<void> {
    this.clear();
    this.freeRunning = false;
    this._info = 'simulation (stopped)';
  }

  /** Play one script once. Interrupts any free-run. */
  play(script: SimScript): void {
    this.freeRunning = false;
    this.clear();
    this._info = `simulation: ${script.label}`;
    this.schedule(script.events);
  }

  /** Continuous random thinking-out-loud until stopped. */
  startFreeRun(): void {
    this.clear();
    this.freeRunning = true;
    this._info = 'simulation: free run';
    this.freeRunTick();
  }

  private freeRunTick(): void {
    if (!this.freeRunning) return;
    this.clear(); // drop the prior (already-fired) script timers
    const script = SIM_SCRIPTS[Math.floor(Math.random() * SIM_SCRIPTS.length)];
    this.schedule(script.events);
    const span = script.events[script.events.length - 1].t;
    // gap after the script before the next utterance begins
    this.timers.push(setTimeout(() => this.freeRunTick(), span + 2500 + Math.random() * 3000));
  }

  private schedule(events: RelEvent[]): void {
    for (const ev of events) {
      this.timers.push(
        setTimeout(() => {
          const t = this.now();
          if (ev.type === 'speech-start') {
            this.segStartT = t; // remember where this utterance began, for transcript alignment
            this.onEvent({ t, type: 'speech-start' });
          } else if (ev.type === 'speech-end') {
            this.onEvent({ t, type: 'speech-end' });
            // A scripted speech-end drives the transcript channel too (demo loop).
            if (ev.text !== undefined) this.emitTranscript(ev.text, this.segStartT, t);
          } else {
            this.onEvent({ t, type: 'eou', verdict: ev.verdict });
          }
        }, ev.t),
      );
    }
  }

  /**
   * Emit one scripted segment on the transcript channel the way the mic path does:
   * a `pending` placeholder at speech-end, then the resolved words a beat later
   * (SIM_STT_MS), so the warmed loop's turn-end → transcript leg is exercised and
   * the gate has genuine words to escalate on. `sim` mode marks these as scripted
   * (not a labelled STT stub), so response-hierarchy reads them as real speech.
   */
  private emitTranscript(text: string, startT: number, endT: number): void {
    const id = this.segmentId++;
    this.onTranscript({ id, startT, endT, text: '', mode: 'sim', pending: true });
    this.timers.push(
      setTimeout(() => {
        this.onTranscript({ id, startT, endT, text, mode: 'sim', pending: false });
      }, SIM_STT_MS),
    );
  }

  private clear(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }
}
