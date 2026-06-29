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

type RelEvent =
  | { t: number; type: 'speech-start' }
  | { t: number; type: 'speech-end' }
  | { t: number; type: 'eou'; verdict: Verdict };

export interface SimScript {
  name: string;
  label: string;
  description: string;
  events: RelEvent[];
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

export class SimAudioSource implements AudioSource {
  readonly kind = 'sim' as const;
  onEvent: (e: InputEvent) => void = () => {};

  private readonly now: () => number;
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
          this.onEvent({ ...ev, t: this.now() } as InputEvent);
        }, ev.t),
      );
    }
  }

  private clear(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }
}
