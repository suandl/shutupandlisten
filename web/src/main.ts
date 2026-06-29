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
import type { TranscriberOptions } from './stt.ts';
import { groupTranscript, type TranscriptSegment, type TurnStartMark, type TurnEndMark } from './transcript.ts';

const now = () => performance.now();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// STT model config from the URL (operator-enable for the feel-test without a
// code edit; default = no model → labelled stub). Local URLs honour the plan's
// no-network-by-default posture — nothing is fetched unless these are set.
//   ?sttEngine=<transformers.js-compatible module URL>
//   &sttModel=<moonshine model id/path>&sttFallback=<whisper-small id/path>
function sttOptionsFromQuery(): TranscriberOptions {
  const q = new URLSearchParams(location.search);
  const o: TranscriberOptions = {};
  const engine = q.get('sttEngine');
  if (engine) o.engineUrl = engine;
  const moon = q.get('sttModel') ?? q.get('moonshine');
  if (moon) o.moonshineModel = moon;
  const whisper = q.get('sttFallback') ?? q.get('whisper');
  if (whisper) o.whisperModel = whisper;
  return o;
}
const sttOptions = sttOptionsFromQuery();

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
const transcriptEl = $('transcript');

// ── transcript state (additive display; aligned to detector turns) ──
const transcriptSegments = new Map<number, TranscriptSegment>();
let turnStarts: TurnStartMark[] = [];
let turnEnds: TurnEndMark[] = [];

function resetTranscript(): void {
  transcriptSegments.clear();
  turnStarts = [];
  turnEnds = [];
  renderTranscript();
}

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
  audio = next === 'mic' ? new MicAudioSource({ now, vadKnobs, sttOptions }) : new SimAudioSource(now);
  wireAudio(audio);
  resetTranscript();
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
  // STT transcripts (mic only) — upsert by id so the pending placeholder is
  // replaced by the resolved text, then re-align against the detector's turns.
  src.onTranscript = (seg: TranscriptSegment) => {
    transcriptSegments.set(seg.id, seg);
    renderTranscript();
  };
}

// ── output handling ──
function handleOut(e: OutputEvent): void {
  logOutput(e);
  // Capture turn boundaries so the transcript can show where each turn ended
  // relative to the words. Strictly read-only — does not touch the detector.
  if (e.type === 'turn-start') {
    turnStarts.push({ turn: e.turn, t: e.t });
    renderTranscript();
  } else if (e.type === 'turn-end') {
    turnEnds.push({ turn: e.turn, t: e.t, reason: e.reason });
    renderTranscript();
  }
  if (e.type === 'response-start') {
    respondInd.dataset.on = 'true';
    beep();
  } else if (e.type === 'response-end' || e.type === 'barge-in') {
    respondInd.dataset.on = 'false';
  }
  refreshStage();
}

// ── transcript rendering: words grouped by turn, with speech-end + turn-end
// markers so the operator can SEE where the patience window cut or held ──
function renderTranscript(): void {
  transcriptEl.replaceChildren();

  if (mode !== 'mic') {
    const hint = document.createElement('div');
    hint.className = 'tx-empty';
    hint.textContent = 'Transcript appears in microphone mode (the simulator drives events with no audio to transcribe).';
    transcriptEl.appendChild(hint);
    return;
  }

  const groups = groupTranscript({
    segments: [...transcriptSegments.values()],
    turnStarts,
    turnEnds,
  });

  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tx-empty';
    empty.textContent = 'Start the microphone and speak — your words appear here, aligned to where each turn ended.';
    transcriptEl.appendChild(empty);
    return;
  }

  for (const g of groups) {
    const turnEl = document.createElement('div');
    turnEl.className = 'tx-turn';

    const head = document.createElement('span');
    head.className = 'tx-turn-head';
    head.textContent = `turn ${g.turn}`;
    turnEl.appendChild(head);

    if (g.segments.length === 0) {
      const ph = document.createElement('span');
      ph.className = 'tx-seg pending';
      ph.textContent = '…';
      turnEl.appendChild(ph);
    }
    for (const seg of g.segments) {
      const word = document.createElement('span');
      const cls = ['tx-seg'];
      if (seg.pending) cls.push('pending');
      if (seg.mode === 'stub') cls.push('stub');
      word.className = cls.join(' ');
      word.textContent = seg.pending ? '…' : seg.text || '∅';
      word.title = `${fmtT(seg.startT)}–${fmtT(seg.endT)} · ${seg.mode}`;
      turnEl.appendChild(word);
      // speech-end tick after each segment's words
      const tick = document.createElement('span');
      tick.className = 'tx-speechend';
      tick.textContent = '⏷';
      tick.title = `speech-end ${fmtT(seg.endT)}`;
      turnEl.appendChild(tick);
    }

    if (g.end) {
      const last = g.segments[g.segments.length - 1];
      const heldMs = last ? Math.round(g.end.t - last.endT) : null;
      const endEl = document.createElement('span');
      endEl.className = `tx-end ${g.end.reason}`;
      endEl.textContent =
        `▏turn-end ${g.end.reason}` + (heldMs !== null ? ` · ${heldMs}ms after last speech` : '');
      endEl.title = `turn ${g.turn} ended at ${fmtT(g.end.t)} (${g.end.reason})`;
      turnEl.appendChild(endEl);
    } else {
      const open = document.createElement('span');
      open.className = 'tx-open';
      open.textContent = '▏open…';
      turnEl.appendChild(open);
    }
    transcriptEl.appendChild(turnEl);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
renderTranscript();
sourceInfo.textContent = audio.info;
