// Harness wiring: knobs ↔ detector, an audio source (simulation or microphone)
// feeding InputEvents, a real-time tick loop so deadlines fire live, and the
// stage/log/stubbed-response UI. The detector (turn-detection.ts) is the same
// tested state machine in both modes; everything here is glue and rendering.

import { TurnDetector, type InputEvent, type OutputEvent, type TurnKnobs } from './turn-detection.ts';
import {
  TURN_KNOBS,
  VAD_KNOBS,
  resolveVadKnobs,
  defaultTurnKnobs,
  type KnobSpec,
  type VadKnobs,
} from './knobs.ts';
import { MicAudioSource, type AudioSource } from './vad.ts';
import { SimAudioSource, SIM_SCRIPTS, DEMO_SCRIPTS, findDemoScript, type SimScript } from './simulator.ts';
import { resolveSttOptions } from './stt-config.ts';
import { resolveSmartTurnOptions } from './smart-turn-config.ts';
import { resolveDenoiseOptions } from './denoise-config.ts';
import {
  groupTranscript,
  type TranscriptSegment,
  type TurnStartMark,
  type TurnEndMark,
  type TurnTranscript,
} from './transcript.ts';
import { resolveListenerOptions } from './listener-config.ts';
import { createListener, listenerStubText, type Listener, type ListenerMode } from './listener.ts';
import { resolveTtsOptions } from './tts-config.ts';
import { createSpeaker, type Speaker, type SpeakerMode } from './tts.ts';
import { LoopMetrics, LOOP_LEGS, legKey } from './loop-metrics.ts';
import {
  decideTier,
  completionProbFromTurnEnd,
  buildListenerRequest,
  type GateDecision,
  type PriorDecision,
  type ConversationTurn,
  type Tier,
} from './response-hierarchy.ts';
// The listener system prompt — imported raw from the single source of truth the
// promptfoo harness also carries, so there is no TS copy to drift (see vite.config).
import LISTENER_SYSTEM_PROMPT from '../../prompts/chatgpt.md?raw';

const now = () => performance.now();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// STT model config. Defaults to the self-hosted same-origin engine + Moonshine/
// Whisper weights (see stt-config.ts / stt.ts), so a provisioned deploy
// transcribes out-of-the-box and an un-provisioned one degrades to the labelled
// stub — nothing is fetched cross-origin and no mic audio leaves the page. The
// URL query retunes it for the feel-test without a code edit:
//   ?stt=off  ·  ?sttEngine=<same-origin url>  ·  ?sttModel=<id>  ·  ?sttFallback=<id>
const sttOptions = resolveSttOptions(location.search, location.href);

// smart-turn (end-of-utterance) config — su-lou.10.1. Same shape as the rest:
// the self-hosted classifier when provisioned (`npm run provision:smart-turn`),
// the labelled duration heuristic otherwise. Until this unit there was no
// provisioner at all, so the heuristic was the ONLY thing that ever ran and the
// silence floor carried all the patience alone. Retunable per run:
//   ?smartTurn=off  ·  ?smartTurnModel=<same-origin url>
const smartTurnOptions = resolveSmartTurnOptions(location.search, location.href);

// Denoise config — background-noise increment 2. An on-device denoise stage
// ahead of the VAD (self-hosted same-origin engine when provisioned; passthrough
// otherwise, so the mic path is unchanged), retunable per run for the noisy
// feel-test:
//   ?denoise=off  ·  ?denoiseEngine=<same-origin url>
const denoiseOptions = resolveDenoiseOptions(location.search, location.href);

// Listener LLM config — same shape as STT: self-hosted same-origin engine + a
// small instruct model by default (a provisioned deploy responds; an
// un-provisioned one / CI degrades to the labelled stub), retunable per run:
//   ?llm=off  ·  ?llmEngine=<same-origin url>  ·  ?llmModel=<id>
const listenerOptions = resolveListenerOptions(location.search, location.href);

// TTS config — U6, same shape again: self-hosted same-origin engine + a small
// on-device voice by default (a provisioned deploy speaks; an un-provisioned one /
// CI degrades to a placeholder tone), retunable per run:
//   ?tts=off  ·  ?ttsEngine=<same-origin url>  ·  ?ttsModel=<id>
const ttsOptions = resolveTtsOptions(location.search, location.href);

// ── detector + live state ──
const turnKnobs: TurnKnobs = defaultTurnKnobs();
// VAD segmentation knobs (Silero via @ricky0123/vad-web). The browser APM
// (noiseSuppression/echoCancellation/autoGainControl) is already forced on by
// vad-web's getUserMedia (see vad.ts), so the increment-1 café lever is the
// Silero on/off thresholds + redemption frames — live-tunable via UI sliders AND
// seeded from ?vad* URL knobs so a noisy room can be felt-out without a rebuild:
//   ?vadPositiveSpeechThreshold=<0.1..0.9> · ?vadNegativeSpeechThreshold=<0.1..0.9> · ?vadRedemptionFrames=<1..40>
const vadKnobs: VadKnobs = resolveVadKnobs(location.search);
const detector = new TurnDetector(turnKnobs, handleOut);

let audio: AudioSource = new SimAudioSource(now);
let mode: 'sim' | 'mic' = 'sim';
let audioCtx: AudioContext | null = null;

// Whether the full warmed loop (transcript → gate → LLM → TTS → loop-metrics) is
// live. True in mic mode, or in sim mode while a loop-driving DEMO_SCRIPT plays —
// the mic-less demo substrate (su-lou.4.1). The classic timing scripts leave it
// off, so their transcript/loop panels keep the "appears in the live loop" hint
// and the tested timing path is untouched.
let simLoopActive = false;
function loopActive(): boolean {
  return mode === 'mic' || simLoopActive;
}

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
const metricsEl = $('loop-metrics');

// ── transcript state (additive display; aligned to detector turns) ──
const transcriptSegments = new Map<number, TranscriptSegment>();
let turnStarts: TurnStartMark[] = [];
let turnEnds: TurnEndMark[] = [];

function resetTranscript(): void {
  // An evaluation left hanging would keep the detector parked in `deciding`, so
  // the next script/session would resume that stale turn instead of opening a
  // fresh one. Decline it: `silence` re-arms to listening at no cost.
  answerEvaluation('silence');
  // …but declining does not END the turn (§4b), and this transcript is being thrown
  // away, so drop it explicitly: the next speech must open a turn the cleared
  // `turnStarts` actually has a mark for.
  detector.dropTurn();
  transcriptSegments.clear();
  turnStarts = [];
  turnEnds = [];
  turnResponses.clear();
  lastListenerSpeechEndT = null;
  loopMetrics.reset();
  stopSpeech();
  renderTranscript();
  renderMetrics();
}

// ── listener (U5): response-hierarchy gate + on-device LLM, additive over the
// transcript. When a turn's patience window CLOSES and its transcript RESOLVES, the
// gate picks a tier (silence / acknowledge = rules-only; reflection / question = the
// LLM) and the listener's reply renders under that turn. Strictly downstream of the
// detector — it reads turn boundaries + words, never alters the tested timing.
//
// Keyed by EVALUATION, not by turn (spec §4b): one turn can close its window several
// times, and each closure is a fresh question — asked over more words than the last —
// that needs its own answer back to the detector. The `utterance` field is what
// everything calibrated to a THOUGHT reads: the ack rotation, the question cooldown,
// the LLM's conversation history, one loop-metrics iteration. ──
interface TurnResponse {
  evaluation: number;
  utterance: number;
  userText: string; // the thinker's transcribed words (gate input + LLM history)
  decision: GateDecision;
  text: string; // rendered reply: ack, LLM reply, LLM stub, or '' for silence
  mode?: ListenerMode; // set for reflection/question (webgpu | wasm | stub)
  status: 'pending' | 'done';
  spoken?: boolean; // guard: this reply's audio was already synthesized + played
  ttsMode?: SpeakerMode; // which voice spoke it (webgpu | wasm | stub tone)
}
// Insertion order IS evaluation order, which the utterance-keyed reads below rely on.
const turnResponses = new Map<number, TurnResponse>();

/** The decision currently shown for a turn: its most recent evaluation's. */
function latestResponseFor(turn: number): TurnResponse | undefined {
  let latest: TurnResponse | undefined;
  for (const r of turnResponses.values()) if (r.utterance === turn) latest = r;
  return latest;
}

// When the companion last RELEASED THE FLOOR (performance.now() ms), or null if it
// has not spoken this session. Set from the detector's response-end / barge-in — the
// moment its response window closed or was cut — NOT from when the TTS audio actually
// finished (a clip can out- or under-run that window). Floor release is the right
// boundary for a restraint/spacing signal: it is when the companion handed the
// conversational turn back, which is what "don't crowd them" spaces against. Feeds
// `EvalContext.msSinceWeLastSpoke`; the stage-1 policy carries it without reading it
// (su-lou.10.3).
let lastListenerSpeechEndT: number | null = null;

// The listener worker + model is heavy, so it is created lazily and only in mic
// mode, then reused. Warmed on mic start so it is ready by the first completed turn.
let listenerPromise: Promise<Listener> | null = null;
function getListener(): Promise<Listener> {
  if (!listenerPromise) listenerPromise = createListener(listenerOptions);
  return listenerPromise;
}
function disposeListener(): void {
  const p = listenerPromise;
  listenerPromise = null;
  if (p) void p.then((l) => l.close()).catch(() => {});
}

// ── TTS (U6): the on-device voice, warmed lazily like the listener and reused.
// The speaker synthesizes the gated reply to PCM (pure/testable); playback and the
// barge-in yield are WebAudio glue that lives here, kept out of the adapter. ──
let speakerPromise: Promise<Speaker> | null = null;
function getSpeaker(): Promise<Speaker> {
  if (!speakerPromise) speakerPromise = createSpeaker(ttsOptions);
  return speakerPromise;
}
function disposeSpeaker(): void {
  const p = speakerPromise;
  speakerPromise = null;
  stopSpeech();
  if (p) void p.then((s) => s.close()).catch(() => {});
}

// The current utterance's WebAudio source, so a barge-in (or a new turn) can cut it.
let currentSpeech: AudioBufferSourceNode | null = null;
function stopSpeech(): void {
  if (!currentSpeech) return;
  try {
    currentSpeech.onended = null;
    currentSpeech.stop();
  } catch {
    /* already stopped */
  }
  currentSpeech = null;
}
function playPcm(pcm: Float32Array, sampleRate: number): void {
  ensureAudioCtx();
  if (!audioCtx || pcm.length === 0 || sampleRate <= 0) return;
  stopSpeech(); // one voice at a time — a new reply replaces the last
  const buf = audioCtx.createBuffer(1, pcm.length, sampleRate);
  buf.getChannelData(0).set(pcm);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.onended = () => {
    if (currentSpeech === src) currentSpeech = null;
  };
  currentSpeech = src;
  src.start();
}

// ── warmed-loop instrumentation (U6): per-stage latency turn-end → transcript →
// gate → reply → speech-start, recorded as the harness observes each stage. ──
const loopMetrics = new LoopMetrics();

// Live device modes, shown next to the source once each adapter resolves.
let liveListenerMode: ListenerMode | null = null;
// ...and WHICH weights that mode loaded. Both listener rungs can report 'webgpu',
// and they are not the same thing — q4f16 is fp16 compute, q4 is fp32 — so a
// readout of "listener (webgpu)" alone hid which one a feel-test was actually
// rating (su-lou.9). The reason a rung was skipped goes to the console via the
// adapter's onDiagnostic.
let liveListenerDtype: string | null = null;
let liveSpeakerMode: SpeakerMode | null = null;
function refreshSourceInfo(): void {
  const parts = [audio.info];
  if (liveListenerMode) parts.push(`listener (${liveListenerMode}${liveListenerDtype ? `/${liveListenerDtype}` : ''})`);
  if (liveSpeakerMode) parts.push(`tts (${liveSpeakerMode})`);
  sourceInfo.textContent = parts.join(' + ');
}

/**
 * Speak a completed turn's gated reply. silence stays silent; acknowledge speaks its
 * short backchannel; reflection/question speak the LLM reply. Synthesis + playback
 * are async and idempotent per turn (the `spoken` guard), so this is safe to call
 * from the reply-ready paths without double-voicing on re-render.
 */
function speakResponse(entry: TurnResponse): void {
  if (!loopActive() || entry.spoken) return;
  const text = entry.text.trim();
  if (!text || entry.decision.tier === 'silence') return; // silence stays silent
  entry.spoken = true;
  void getSpeaker()
    .then((sp) => sp.synthesize(text))
    .then((res) => {
      entry.ttsMode = res.mode;
      loopMetrics.mark(entry.utterance, 'speech-start', now());
      playPcm(res.audio, res.sampleRate);
      renderMetrics();
      renderTranscript();
    })
    .catch(() => {
      /* the speaker never rejects (it degrades to the tone); nothing to do */
    });
}

// ── knobs ──
renderKnobs($('turn-knobs'), TURN_KNOBS, (key, value) => {
  detector.setKnobs({ [key]: value } as Partial<TurnKnobs>);
  refreshStage();
});
renderKnobs(
  $('vad-knobs'),
  VAD_KNOBS,
  (key, value) => {
    (vadKnobs as unknown as Record<string, number>)[key] = value as number;
  },
  // Seed the sliders from the ?vad*-resolved values (not the static spec
  // defaults) so the URL overrides are visible and further-tunable.
  vadKnobs as unknown as Record<string, number | boolean>,
);

function renderKnobs(
  container: HTMLElement,
  specs: KnobSpec[],
  onChange: (key: string, value: number | boolean) => void,
  initial?: Record<string, number | boolean>,
): void {
  for (const spec of specs) {
    // Initial rendered value: a per-key override (e.g. ?vad*-resolved knobs)
    // when supplied, else the static spec default.
    const initialValue = initial?.[spec.key] ?? spec.default;
    const wrap = document.createElement('div');
    wrap.className = spec.kind === 'toggle' ? 'knob toggle' : 'knob';
    if (spec.kind === 'toggle') {
      const id = `k-${spec.key}`;
      wrap.innerHTML =
        `<label for="${id}"><span>${spec.label}</span>` +
        `<input type="checkbox" id="${id}" ${initialValue ? 'checked' : ''} /></label>` +
        `<div class="help">${spec.help}</div>`;
      const input = wrap.querySelector('input') as HTMLInputElement;
      input.addEventListener('change', () => onChange(spec.key, input.checked));
    } else {
      const id = `k-${spec.key}`;
      const fmt = (v: number) => `${v}${spec.unit ? ' ' + spec.unit : ''}`;
      wrap.innerHTML =
        `<label for="${id}"><span>${spec.label}</span><span class="val" id="${id}-v">${fmt(
          initialValue as number,
        )}</span></label>` +
        `<input type="range" id="${id}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${initialValue}" />` +
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
// A loop-driving DEMO_SCRIPT starts from a clean transcript/metrics slate (so its
// turns read 1..N and the loop panels light up); a classic timing script clears any
// prior demo loop state and reverts the panels to their hint. Either way this is the
// single entry the ?demo= URL and the buttons share.
function playSimScript(script: SimScript): void {
  if (mode !== 'sim') return;
  ensureAudioCtx();
  simLoopActive = Boolean(script.drivesLoop);
  resetTranscript();
  (audio as SimAudioSource).play(script);
  refreshSourceInfo();
}

const simControls = $('sim-controls');
for (const script of [...SIM_SCRIPTS, ...DEMO_SCRIPTS]) {
  const b = document.createElement('button');
  b.textContent = script.label;
  b.title = script.description;
  b.addEventListener('click', () => playSimScript(script));
  simControls.appendChild(b);
}
{
  const free = document.createElement('button');
  free.textContent = 'Free run';
  free.addEventListener('click', () => {
    ensureAudioCtx();
    simLoopActive = false; // free-run cycles the timing scripts — no warmed loop
    resetTranscript();
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
    refreshSourceInfo();
    // Warm the listener AND the voice now so both are ready by the first completed
    // turn; when each resolves, surface which mode is live next to the source.
    // Guard against a stop / mode-switch that happened while they were loading.
    void getListener().then((l) => {
      if (mode === 'mic' && listenerPromise) {
        liveListenerMode = l.mode;
        liveListenerDtype = l.dtype ?? null;
        refreshSourceInfo();
      }
    });
    void getSpeaker().then((s) => {
      if (mode === 'mic' && speakerPromise) {
        liveSpeakerMode = s.mode;
        refreshSourceInfo();
      }
    });
  } catch (err) {
    sourceInfo.textContent = `mic failed: ${(err as Error).message} — staying in simulation`;
  }
});
$('mic-stop').addEventListener('click', () =>
  void audio.stop().then(() => {
    disposeListener();
    disposeSpeaker();
    liveListenerMode = null;
    liveListenerDtype = null;
    liveSpeakerMode = null;
    sourceInfo.textContent = audio.info;
  }),
);

// ── mode switch ──
$('mode').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => switchMode((btn as HTMLElement).dataset.mode as 'sim' | 'mic'));
});

async function switchMode(next: 'sim' | 'mic'): Promise<void> {
  if (next === mode) return;
  simLoopActive = false; // leaving sim drops any demo loop; mic mode drives the loop by mode
  await audio.stop();
  disposeListener(); // free the LLM worker when leaving mic; recreated lazily on next mic start
  disposeSpeaker(); // free the TTS worker + stop any playback; recreated lazily on next mic start
  liveListenerMode = null;
  liveListenerDtype = null;
  liveSpeakerMode = null;
  mode = next;
  audio =
    next === 'mic'
      ? new MicAudioSource({ now, vadKnobs, smartTurnOptions, sttOptions, denoiseOptions })
      : new SimAudioSource(now);
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
    // A speech-start can abandon an outstanding evaluation — including one born
    // in this very call, when the resume lands after the deadline (advance()
    // evaluates, then the resume abandons it). Checked on the settled state
    // rather than on the event type, so any future abandon path is covered too.
    cancelAbandonedEvaluation();
    refreshStage();
  };
  // STT transcripts (mic only) — upsert by id so the pending placeholder is
  // replaced by the resolved text, then re-align against the detector's turns.
  src.onTranscript = (seg: TranscriptSegment) => {
    transcriptSegments.set(seg.id, seg);
    renderTranscript();
  };
}

// ── the decision loop (the un-collapsed `Deciding` state) ──
//
// The detector no longer commits to responding when the patience window closes:
// it emits `evaluate` and waits for a verdict. This harness is what answers.
// Which answer, and how soon, depends on what is actually wired up:
//   - timing-only (the classic sim scripts, no transcript and no gate): answer
//     `speak` at once, so the stubbed response park behaves exactly as it did
//     when `Deciding` was collapsed into `responding`;
//   - warmed loop (mic, or a loop-driving demo): the response-hierarchy gate
//     answers, and only when the evidence it needs has landed — the transcript
//     resolving IS the trigger (see maybeRespond), never a timer.
// An evaluation the harness never answers would park the detector in `deciding`,
// so every path out of here must end in exactly one answer.
let awaiting: { evaluation: number; turn: number } | null = null;

/** Answer the outstanding evaluation, if there is one. Safe to call unconditionally. */
function answerEvaluation(outcome: 'speak' | 'silence'): void {
  if (awaiting === null) return;
  awaiting = null;
  // Re-entrant when called from handleOut (inside detector.input); the detector
  // queues such an event and applies it as soon as the current one settles.
  detector.input({ t: now(), type: 'decision', outcome });
  refreshStage();
}

/**
 * Drop an evaluation the detector ABANDONED under us, restoring the turn to open.
 *
 * The thinker resuming while a verdict is outstanding abandons the evaluation and
 * reopens the SAME turn (spec §6) — and it does so SILENTLY: unlike a barge-in,
 * an abandonment emits no output event, so the only way to see it is that the
 * detector is no longer `deciding` while we still believe it is. Left uncancelled,
 * `maybeRespond` would gate that turn the moment its transcript resolved and
 * `speakResponse` would talk over someone who is mid-sentence — with no barge-in
 * to cut it, because the detector never took the floor.
 *
 * The turn's end mark and loop-metric origin go with it: the window that closed
 * was not this turn's end, and the next (real) evaluation must be free to mark it.
 */
function cancelAbandonedEvaluation(): void {
  if (awaiting === null || detector.state === 'deciding') return;
  const { turn } = awaiting;
  awaiting = null;
  turnEnds = turnEnds.filter((m) => m.turn !== turn);
  loopMetrics.clear(turn);
  renderTranscript();
  renderMetrics();
}

// ── output handling ──
function handleOut(e: OutputEvent): void {
  logOutput(e);
  // Capture turn boundaries so the transcript can show where each turn ended
  // relative to the words. Strictly read-only — does not touch the detector.
  if (e.type === 'turn-start') {
    turnStarts.push({ turn: e.turn, t: e.t });
    // A new turn means the thinker is speaking again — yield the floor: cut any
    // reply still playing (covers a TTS clip that outlasts the responding window).
    stopSpeech();
    renderTranscript();
  } else if (e.type === 'evaluate') {
    // The patience window closed. THIS is where the transcript's turn-end marker
    // and the loop metric's first stage belong — the moment the detector read the
    // pause as an end-of-thought — whether or not the companion goes on to speak.
    // A superseding re-evaluation (same `evaluation`) re-uses the first mark: the
    // patience deadline is where the window closed, and it has not moved.
    //
    // A NEW evaluation of the same turn is the other case (§4b): the gate declined,
    // the thinker kept going, and the window has now closed again further along. Its
    // predecessor marked an origin for a loop iteration that never happened, so
    // replace it — the same reasoning cancelAbandonedEvaluation clears marks under.
    if (!turnEnds.some((m) => m.evaluation === e.evaluation)) {
      if (turnEnds.some((m) => m.turn === e.turn)) {
        turnEnds = turnEnds.filter((m) => m.turn !== e.turn);
        loopMetrics.clear(e.turn);
      }
      turnEnds.push({ turn: e.turn, evaluation: e.evaluation, t: e.t, reason: e.reason });
      loopMetrics.mark(e.turn, 'turn-end', e.t);
    }
    awaiting = { evaluation: e.evaluation, turn: e.turn };
    if (loopActive()) renderTranscript(); // → maybeRespond answers once the transcript resolves
    else answerEvaluation('speak'); // timing-only: the stubbed response, exactly as before
  }
  if (e.type === 'response-start') {
    respondInd.dataset.on = 'true';
  } else if (e.type === 'response-end' || e.type === 'barge-in') {
    respondInd.dataset.on = 'false';
    // The companion just yielded the floor — completed or cut off by a barge-in.
    // Either way this is the last moment it was speaking (see msSinceWeLastSpoke).
    lastListenerSpeechEndT = e.t;
  }
  // Barge-in — the detector emits it on speech-start during responding — yields the
  // voice instantly, reusing the tested detector event without altering its timing.
  if (e.type === 'barge-in') stopSpeech();
  refreshStage();
}

// ── transcript rendering: words grouped by turn, with speech-end + turn-end
// markers so the operator can SEE where the patience window cut or held ──
function renderTranscript(): void {
  transcriptEl.replaceChildren();

  if (!loopActive()) {
    const hint = document.createElement('div');
    hint.className = 'tx-empty';
    hint.textContent =
      'Transcript appears in microphone mode or the U6 warmed-loop demo (the timing scripts drive events with no audio to transcribe).';
    transcriptEl.appendChild(hint);
    return;
  }

  const groups = groupTranscript({
    segments: [...transcriptSegments.values()],
    turnStarts,
    turnEnds,
  });

  // U5: run the response-hierarchy gate + listener for any newly-completed turn.
  maybeRespond(groups);

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

    // U5: the listener's reply for this turn (once the gate has decided it).
    const resp = latestResponseFor(g.turn);
    if (resp) turnEl.appendChild(renderResponse(resp));

    transcriptEl.appendChild(turnEl);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Kick off the gate + listener for any turn whose patience window has closed AND
// whose transcript has fully resolved. The gate decision is synchronous (renders at
// once); a reflection/question additionally calls the LLM, which resolves later
// and re-renders. Idempotent — an evaluation already handled is skipped — so it is
// safe to call on every render.
//
// It is also what answers the detector's outstanding `evaluate`: the gate's tier
// IS the verdict (`silence` declines the floor; every speaking tier takes it).
// Waiting here for the transcript to resolve is the evidence-driven trigger — the
// gate is asked when its input exists, not on a clock.
function maybeRespond(groups: TurnTranscript[]): void {
  if (!loopActive()) return;
  for (const g of groups) {
    if (!g.end) continue;
    const evaluation = g.end.evaluation;
    if (turnResponses.has(evaluation)) {
      // Already gated. A re-evaluation of the same window (fresh EOU evidence) still
      // needs an answer, and the decision has not changed — replay it rather than
      // re-running the gate, or the detector waits on a verdict that never comes.
      answerFor(evaluation, turnResponses.get(evaluation)?.decision.tier);
      continue;
    }
    if (g.segments.some((s) => s.pending)) continue; // wait for STT to resolve first

    // Real words only: a stub placeholder ("⟨speech 1.4s …⟩") is not transcription,
    // so it must not read as a substantive turn. All-stub/empty ⇒ '' ⇒ silence.
    //
    // These are the WHOLE turn's segments, so a second evaluation of a turn the gate
    // declined into sees the thought so far and not just the words since the pause —
    // `EvalContext.utteranceTextSoFar`, and the thing that stops rule 4 backchannelling
    // over a substantive turn once the floor is short.
    const userText = g.segments
      .filter((s) => !s.pending && s.mode !== 'stub')
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Every decision made about an EARLIER turn, stamped with that turn — so the
    // question cooldown counts thoughts, not evaluation ticks (§4b). Already in
    // evaluation order (the map's insertion order), hence ascending by turn too.
    const priorDecisions: PriorDecision[] = [...turnResponses.values()]
      .filter((r) => r.utterance < g.turn)
      .map((r) => ({ turn: r.utterance, tier: r.decision.tier }));

    // How long the pause had run when the detector evaluated it: last speech-end in
    // this turn → where the patience window closed. 0 only when the turn has NO
    // segments at all; an untranscribed stub placeholder still carries a real
    // speech-end, so its presence yields a genuine time here.
    const lastSpeechEndT = g.segments.reduce((m, s) => Math.max(m, s.endT), 0);

    // Stage 2+3: the transcript resolved (we have userText) and the gate decides.
    loopMetrics.mark(g.turn, 'transcript', now());
    const decision = decideTier({
      utteranceIndex: g.turn,
      utteranceTextSoFar: userText,
      // Stage-1 bridge: TurnEndMark carries the detector's two-valued reason, not
      // the classifier's score, so the gate gets certainty stand-ins. Stage 2
      // threads smart-turn's real P(complete) through here instead — the widened
      // contract is what lets that be a one-line change (su-lou.10.3).
      completionProb: completionProbFromTurnEnd(g.end.reason),
      // No segments ⇒ no speech-end to measure from: NaN, the "no measurement"
      // sentinel (never a real 0-length pause), read the fail-safe way a non-finite
      // completionProb is — see the field doc in response-hierarchy.ts.
      msSinceSpeechEnd: lastSpeechEndT > 0 ? Math.max(0, g.end.t - lastSpeechEndT) : NaN,
      msSinceWeLastSpoke:
        lastListenerSpeechEndT === null ? Infinity : Math.max(0, g.end.t - lastListenerSpeechEndT),
      priorDecisions,
    });
    loopMetrics.mark(g.turn, 'gate', now());
    const entry: TurnResponse = {
      evaluation,
      utterance: g.turn,
      userText,
      decision,
      text: decision.ackText ?? '',
      status: decision.callModel ? 'pending' : 'done',
    };
    turnResponses.set(evaluation, entry);

    // The verdict, back to the detector: `silence` re-arms it to listening with
    // no response park; a speaking tier takes the floor. The reply text is still
    // being generated at this point for reflection/question — the decision to
    // SPEAK is what the detector is waiting on, not the words.
    answerFor(evaluation, decision.tier);

    if (decision.callModel) {
      const request = buildListenerRequest({
        systemPrompt: LISTENER_SYSTEM_PROMPT,
        tier: decision.tier,
        currentTurnText: userText,
        history: conversationHistory(g.turn),
      });
      void getListener()
        .then((l) => l.respond(request))
        .then((res) => {
          entry.text = res.text;
          entry.mode = res.mode;
          entry.status = 'done';
          loopMetrics.mark(g.turn, 'reply', now()); // stage 4: reply text ready
          speakResponse(entry); // stage 5 (speech-start) recorded when playback begins
          renderTranscript();
          renderMetrics();
        })
        .catch(() => {
          entry.text = listenerStubText(decision.tier);
          entry.mode = 'stub';
          entry.status = 'done';
          loopMetrics.mark(g.turn, 'reply', now());
          speakResponse(entry);
          renderTranscript();
          renderMetrics();
        });
    } else if (entry.text) {
      // acknowledge: the backchannel is ready synchronously → speak it now.
      // (silence: text is '' → it stays silent, nothing to voice.)
      loopMetrics.mark(g.turn, 'reply', now());
      speakResponse(entry);
    }
    renderMetrics();
  }
}

/** Feed the gate's tier back as the detector's verdict, if it is what is awaited. */
function answerFor(evaluation: number, tier: Tier | undefined): void {
  if (!tier || awaiting?.evaluation !== evaluation) return;
  answerEvaluation(tier === 'silence' ? 'silence' : 'speak');
}

// Prior turns as an alternating thinker/listener history for the LLM. One entry per
// TURN, not per evaluation: a turn's last evaluation holds its full text and the
// reply that was actually spoken, so the earlier looks at the same growing thought
// would only repeat the thinker back at itself. Silent turns contribute nothing
// (their empty reply text is dropped downstream).
function conversationHistory(beforeTurn: number): ConversationTurn[] {
  const latest = new Map<number, TurnResponse>();
  for (const r of turnResponses.values()) if (r.utterance < beforeTurn) latest.set(r.utterance, r);
  const turns: ConversationTurn[] = [];
  for (const utterance of [...latest.keys()].sort((a, b) => a - b)) {
    const r = latest.get(utterance) as TurnResponse;
    turns.push({ speaker: 'thinker', text: r.userText });
    if (r.text) turns.push({ speaker: 'listener', text: r.text });
  }
  return turns;
}

// Render one turn's listener reply: a faint "held" marker for silence, a tier chip
// plus the backchannel for acknowledge, or the tier chip plus the LLM reply (or its
// labelled stub / a pending ellipsis) for reflection/question.
function renderResponse(r: TurnResponse): HTMLElement {
  const el = document.createElement('div');
  el.className = `tx-response ${r.decision.tier}`;
  el.title = r.decision.reason + (r.mode ? ` · ${r.mode}` : '');

  if (r.decision.tier === 'silence') {
    el.classList.add('held');
    el.textContent = '· held ·';
    return el;
  }

  el.appendChild(tierChip(r.decision.tier));
  const body = document.createElement('span');
  body.className = 'tx-response-body';
  if (r.decision.callModel && r.status === 'pending') {
    body.classList.add('pending');
    body.textContent = '…';
  } else {
    if (r.mode === 'stub') body.classList.add('stub');
    body.textContent = r.text || '∅';
  }
  el.appendChild(body);
  return el;
}

function tierChip(tier: Tier): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `tx-tier ${tier}`;
  chip.textContent = tier;
  return chip;
}

// ── warmed-loop metrics panel (U6): the per-stage latency of the end-to-end loop,
// so the operator can SEE where time goes between a turn ending and the companion
// speaking. Mic-only (the simulator drives no real STT/LLM/TTS pipeline). ──
function renderMetrics(): void {
  metricsEl.replaceChildren();

  if (!loopActive()) {
    const hint = document.createElement('div');
    hint.className = 'tx-empty';
    hint.textContent = 'Loop latency appears in microphone mode or the U6 warmed-loop demo, once a turn has been spoken.';
    metricsEl.appendChild(hint);
    return;
  }

  const summary = loopMetrics.summary();
  const head = document.createElement('div');
  head.className = 'lm-summary';
  head.textContent =
    summary.completed > 0
      ? `${summary.completed} spoken · mean turn-end→speech ${summary.meanTotalMs}ms`
      : 'waiting for the first spoken reply…';
  metricsEl.appendChild(head);

  // Per-leg mean latency (the pipeline's costs: STT / gate / LLM / TTS).
  const legRows = LOOP_LEGS.map(({ from, to }) => ({ from, to, ms: summary.meanLegMs[legKey(from, to)] })).filter(
    (r) => r.ms !== undefined,
  );
  if (legRows.length) {
    const legs = document.createElement('div');
    legs.className = 'lm-legs';
    for (const r of legRows) {
      const row = document.createElement('div');
      row.className = 'lm-leg';
      const label = document.createElement('span');
      label.className = 'lm-leg-label';
      label.textContent = `${r.from} → ${r.to}`;
      const val = document.createElement('span');
      val.className = 'lm-leg-val';
      val.textContent = `${r.ms}ms`;
      row.append(label, val);
      legs.appendChild(row);
    }
    metricsEl.appendChild(legs);
  }

  // Recent per-turn totals (most-recent first), so a slow turn stands out.
  const recent = loopMetrics.all().slice(-6).reverse();
  if (recent.length) {
    const list = document.createElement('div');
    list.className = 'lm-turns';
    for (const tl of recent) {
      const row = document.createElement('div');
      row.className = 'lm-turn';
      row.textContent =
        tl.totalMs !== null ? `turn ${tl.turn}: ${tl.totalMs}ms` : `turn ${tl.turn}: — (not spoken)`;
      list.appendChild(row);
    }
    metricsEl.appendChild(list);
  }
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
    patienceCap.textContent =
      snap.state === 'responding'
        ? 'responding…'
        : snap.state === 'deciding'
          ? 'patience window closed — deciding whether to speak…'
          : 'patience window idle';
  }
}

// ── tick loop: keep wall-clock advancing so deadlines fire live ──
setInterval(() => {
  detector.input({ t: now(), type: 'tick' });
  // No-op today (a tick cannot abandon) — keeps the settled-state abandon check
  // true at every detector.input feeder.
  cancelAbandonedEvaluation();
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
  const trigger = e.type === 'evaluate' ? ` [${e.trigger}]` : '';
  append(e.type, `${fmtT(e.t)}  → ${e.type} turn ${e.turn}${reason}${trigger}`);
}

// ── WebAudio context for TTS playback, created lazily on the first user gesture
// (a click on a sim script or mic-start) so autoplay policy is satisfied. ──
function ensureAudioCtx(): void {
  if (!audioCtx) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  void audioCtx?.resume();
}

refreshStage();
renderTranscript();
renderMetrics();
sourceInfo.textContent = audio.info;

// ── ?demo= entrypoint (su-lou.4.1): the stable, deterministic URL the PR-level
// capture engine points at. In sim mode (the default) it auto-runs the named
// loop-driving scenario a tick after load, so a capture script only navigates and
// waits — no clicking. Composes with the existing knob params, e.g.
// ?demo=u6-warmed-loop&llm=off&tts=off to force the fast, deterministic stub
// substrate (the real models degrade to the same stub/tone anyway — su-lou.8). ──
{
  const demoName = new URLSearchParams(location.search).get('demo');
  if (demoName && mode === 'sim') {
    const script = findDemoScript(demoName);
    if (script) {
      // A beat after load so the tick loop + first render are live before it plays.
      setTimeout(() => playSimScript(script), 250);
    } else {
      console.warn(
        `Ignoring ?demo=${demoName}: no such demo scenario. Known: ${DEMO_SCRIPTS.map((s) => s.name).join(', ')}.`,
      );
    }
  }
}
