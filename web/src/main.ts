// Harness wiring: knobs ↔ detector, an audio source (simulation or microphone)
// feeding InputEvents, a real-time tick loop so deadlines fire live, and the
// stage/log/stubbed-response UI. The detector (turn-detection.ts) is the same
// tested state machine in both modes; everything here is glue and rendering.

import { TurnDetector, type InputEvent, type OutputEvent, type TurnKnobs } from './turn-detection.ts';
import {
  TURN_KNOBS,
  VAD_KNOBS,
  DEFAULT_VAD_KNOBS,
  defaultTurnKnobs,
  type KnobSpec,
  type VadKnobs,
} from './knobs.ts';
import { MicAudioSource, type AudioSource } from './vad.ts';
import { SimAudioSource, SIM_SCRIPTS } from './simulator.ts';

const now = () => performance.now();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── detector + live state ──
const turnKnobs: TurnKnobs = defaultTurnKnobs();
const vadKnobs: VadKnobs = { ...DEFAULT_VAD_KNOBS };
const detector = new TurnDetector(turnKnobs, handleOut);

let audio: AudioSource = new SimAudioSource(now);
let mode: 'sim' | 'mic' = 'sim';
let audioCtx: AudioContext | null = null;

wireAudio(audio);

// ── element refs ──
const badge = $('state-badge');
const turnN = $('turn-n');
const verdictEl = $('verdict');
const armEl = $('arm');
const patienceFill = $<HTMLDivElement>('patience-fill');
const patienceCap = $('patience-cap');
const respondInd = $('respond-ind');
const logEl = $('log');
const sourceInfo = $('source-info');

// ── knobs ──
renderKnobs($('turn-knobs'), TURN_KNOBS, (key, value) => {
  detector.setKnobs({ [key]: value } as Partial<TurnKnobs>);
  refreshStage();
});
renderKnobs($('vad-knobs'), VAD_KNOBS, (key, value) => {
  (vadKnobs as unknown as Record<string, number>)[key] = value as number;
});

function renderKnobs(
  container: HTMLElement,
  specs: KnobSpec[],
  onChange: (key: string, value: number | boolean) => void,
): void {
  for (const spec of specs) {
    const wrap = document.createElement('div');
    wrap.className = spec.kind === 'toggle' ? 'knob toggle' : 'knob';
    if (spec.kind === 'toggle') {
      const id = `k-${spec.key}`;
      wrap.innerHTML =
        `<label for="${id}"><span>${spec.label}</span>` +
        `<input type="checkbox" id="${id}" ${spec.default ? 'checked' : ''} /></label>` +
        `<div class="help">${spec.help}</div>`;
      const input = wrap.querySelector('input') as HTMLInputElement;
      input.addEventListener('change', () => onChange(spec.key, input.checked));
    } else {
      const id = `k-${spec.key}`;
      const fmt = (v: number) => `${v}${spec.unit ? ' ' + spec.unit : ''}`;
      wrap.innerHTML =
        `<label for="${id}"><span>${spec.label}</span><span class="val" id="${id}-v">${fmt(
          spec.default as number,
        )}</span></label>` +
        `<input type="range" id="${id}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.default}" />` +
        `<div class="help">${spec.help}</div>`;
      const input = wrap.querySelector('input') as HTMLInputElement;
      const valEl = wrap.querySelector('.val') as HTMLElement;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        valEl.textContent = fmt(v);
        onChange(spec.key, v);
      });
    }
    container.appendChild(wrap);
  }
}

// ── simulation controls ──
const simControls = $('sim-controls');
for (const script of SIM_SCRIPTS) {
  const b = document.createElement('button');
  b.textContent = script.label;
  b.title = script.description;
  b.addEventListener('click', () => {
    ensureAudioCtx();
    (audio as SimAudioSource).play(script);
  });
  simControls.appendChild(b);
}
{
  const free = document.createElement('button');
  free.textContent = 'Free run';
  free.addEventListener('click', () => {
    ensureAudioCtx();
    (audio as SimAudioSource).startFreeRun();
  });
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => void audio.stop());
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Play a script, then drag the silence floor — watch the same pause cut off below it and hold above it.';
  simControls.append(free, stop, hint);
}

// ── microphone controls ──
$('mic-start').addEventListener('click', async () => {
  ensureAudioCtx();
  try {
    await audio.start();
    sourceInfo.textContent = audio.info;
  } catch (err) {
    sourceInfo.textContent = `mic failed: ${(err as Error).message} — staying in simulation`;
  }
});
$('mic-stop').addEventListener('click', () => void audio.stop().then(() => (sourceInfo.textContent = audio.info)));

// ── mode switch ──
$('mode').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => switchMode((btn as HTMLElement).dataset.mode as 'sim' | 'mic'));
});

async function switchMode(next: 'sim' | 'mic'): Promise<void> {
  if (next === mode) return;
  await audio.stop();
  mode = next;
  audio = next === 'mic' ? new MicAudioSource({ now, vadKnobs }) : new SimAudioSource(now);
  wireAudio(audio);
  $('mode')
    .querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.mode === next)));
  $('sim-controls').style.display = next === 'sim' ? 'flex' : 'none';
  $('mic-controls').style.display = next === 'mic' ? 'flex' : 'none';
  sourceInfo.textContent = audio.info;
}

function wireAudio(src: AudioSource): void {
  src.onEvent = (e: InputEvent) => {
    if (e.type === 'eou') {
      // Mic events carry completionProb (thresholded here); sim events carry a
      // direct verdict. Show whichever is present.
      verdictEl.textContent =
        typeof e.completionProb === 'number'
          ? `${e.completionProb >= detector.config.completionThreshold ? 'complete' : 'incomplete'} (${e.completionProb.toFixed(2)})`
          : (e.verdict ?? '—');
    }
    logInput(e);
    detector.input(e);
    refreshStage();
  };
}

// ── output handling ──
function handleOut(e: OutputEvent): void {
  logOutput(e);
  if (e.type === 'response-start') {
    respondInd.dataset.on = 'true';
    beep();
  } else if (e.type === 'response-end' || e.type === 'barge-in') {
    respondInd.dataset.on = 'false';
  }
  refreshStage();
}

// ── stage rendering ──
function refreshStage(): void {
  const snap = detector.peek(now());
  badge.dataset.state = snap.state;
  badge.textContent = snap.state.toUpperCase();
  turnN.textContent = String(snap.turn);
  armEl.textContent = detector.config.useSmartTurn ? 'smart-turn + floor' : 'patience-only (baseline)';
  if (snap.state !== 'pending') verdictEl.textContent = snap.verdict ?? '—';

  if (snap.state === 'pending' && snap.msUntilTurnEnd !== null) {
    const total =
      detector.config.silenceFloorMs +
      (detector.config.useSmartTurn && snap.verdict === 'incomplete' ? detector.config.incompleteExtensionMs : 0);
    const elapsed = Math.max(0, total - snap.msUntilTurnEnd);
    patienceFill.style.width = `${total > 0 ? (elapsed / total) * 100 : 0}%`;
    patienceCap.textContent = `patience: ${Math.round(snap.msUntilTurnEnd)}ms left of ${total}ms${
      snap.verdict === 'incomplete' ? ' (held by incomplete veto)' : ''
    }`;
  } else {
    patienceFill.style.width = '0%';
    patienceCap.textContent = snap.state === 'responding' ? 'responding (stubbed)…' : 'patience window idle';
  }
}

// ── tick loop: keep wall-clock advancing so deadlines fire live ──
setInterval(() => {
  detector.input({ t: now(), type: 'tick' });
  refreshStage();
}, 90);

// ── logging ──
function fmtT(t: number): string {
  return `${(t / 1000).toFixed(2)}s`;
}
function append(cls: string, text: string): void {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  logEl.prepend(div);
  while (logEl.childElementCount > 200) logEl.lastElementChild?.remove();
}
function logInput(e: InputEvent): void {
  const extra = e.type === 'eou' ? ` ${e.verdict ?? ''}${e.completionProb !== undefined ? e.completionProb.toFixed(2) : ''}` : '';
  append('in', `${fmtT(e.t)}  ← ${e.type}${extra}`);
}
function logOutput(e: OutputEvent): void {
  const reason = 'reason' in e ? ` (${e.reason})` : '';
  append(e.type, `${fmtT(e.t)}  → ${e.type} turn ${e.turn}${reason}`);
}

// ── a soft canned tone for the stubbed response (no TTS) ──
function ensureAudioCtx(): void {
  if (!audioCtx) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  void audioCtx?.resume();
}
function beep(): void {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 240;
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(audioCtx.destination);
  const t = audioCtx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.start(t);
  osc.stop(t + 0.2);
}

refreshStage();
sourceInfo.textContent = audio.info;
