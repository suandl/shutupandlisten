// The response-hierarchy gate — U5's crux, and the half of the bead that is pure
// and fully testable independent of any model.
//
// The quiet-companion "response hierarchy" (CONCEPTS.md) is the listener's ordered
// default behaviour:
//
//     silence → minimal acknowledgment → short momentum-preserving reflection
//             → one brief follow-up question         ("escalate slowly")
//
// NOTE ON THE BEAD WORDING: the bead names the ladder "listen > acknowledge >
// probe > advise". That is shorthand — the repo's canonical hierarchy
// (CONCEPTS.md:16-19, prompts/chatgpt.md) is the four tiers above, and it
// deliberately has NO "advise" rung: advising/coaching/solving are on the
// listener's explicit Do-NOT list (prompts/chatgpt.md, judges/restraint.txt). So
// the bead's terms map onto the canon — listen→silence, acknowledge→acknowledge,
// probe→reflection+question — and "advise" is intentionally dropped. Building the
// literal bead ladder would contradict the product's core restraint principle.
//
// This module implements the "reduced role" (CONCEPTS.md:52-55): the endpointing
// + RULES layer decides silence and acknowledgments with NO model call, and the
// small on-device LLM is invoked ONLY for the substantive tiers (reflection /
// question). That L1-2-rules / L3-4-model split is the U5 gate contract from the
// validation plan's pipeline flowchart. The routing rules mirror the only existing
// prototype, promptfoo/providers/reduced-role.js (`_shouldEscalate`), and extend
// it with the audio+timing signal that a live browser gate has but a transcript
// gate does not: the EOU classifier's completion probability and the pause's timing
// (`EvalContext`) — exactly the "live-gate-vs-text-gate gap" that reduced-role.js's
// header flags.
//
// PURE — no DOM, no model, no I/O. `decideTier` is an `(EvalContext) -> decision`
// reducer in the same discipline as turn-detection.ts and transcript.ts, so the
// escalate-slowly policy is pinned by unit tests and only the *wording* of a
// substantive reply (never whether the listener over-steps) depends on the model.
// The banned-phrase avoid-list is deliberately NOT carried here — like the
// prototype, it lives in the system prompt (prompts/chatgpt.md, fed to the model)
// and judges/restraint.txt (scored); a third copy would only drift.

// ── The four rungs of the response hierarchy, lowest → highest ──

/** A rung of the response hierarchy. `silence`/`acknowledge` are rules-only; `reflection`/`question` call the LLM. */
export type Tier = 'silence' | 'acknowledge' | 'reflection' | 'question';

/** Lowest → highest. Index in this array IS the rung height. */
export const TIERS: readonly Tier[] = ['silence', 'acknowledge', 'reflection', 'question'] as const;

/** Rung height (0..3); higher = more involved / more escalated. */
export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** The higher (more involved) of two tiers. */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** The lower (more restrained) of two tiers. */
export function minTier(a: Tier, b: Tier): Tier {
  return tierRank(a) <= tierRank(b) ? a : b;
}

/** True for the tiers that require the on-device LLM (reflection / question). */
export function tierCallsModel(t: Tier): boolean {
  return tierRank(t) >= tierRank('reflection');
}

// ── Gate configuration (defaults lifted from the reduced-role prototype) ──

/**
 * Natural level-2 minimal acknowledgments, rotated per turn so a run of gated
 * turns never reads as one stuck token. Same set as
 * promptfoo/providers/reduced-role.js DEFAULT_ACKS.
 */
export const DEFAULT_ACKS: readonly string[] = ['mm', 'yeah', 'mhm', 'right', 'mm-hm'] as const;

/**
 * Word count at/above which a finished, non-question thinker turn counts as
 * "substantive" and escalates to the model. reduced-role.js's primary knob
 * (DEFAULT_SUBSTANTIVE_WORDS = 12).
 */
export const DEFAULT_SUBSTANTIVE_WORDS = 12;

/**
 * Minimum turns between two listener-initiated questions. Enforces "escalate
 * slowly; most pauses should not become questions" and the variety judge's
 * anti-repetition — a direct question FROM the thinker bypasses it.
 */
export const DEFAULT_QUESTION_COOLDOWN_TURNS = 2;

/**
 * `EvalContext.completionProb` at/above this reads as a finished thought; below it
 * the EOU classifier called the pause INCOMPLETE and rule 2 holds silence. Higher ⇒
 * more patient. Mirrors the detector's own knob (turn-detection.ts
 * `DEFAULT_KNOBS.completionThreshold`) — the same comparison that used to be
 * collapsed into the `extended` turn-end reason before the gate ever saw it.
 *
 * STAGE-2 DRIFT HAZARD (two knobs, one probability). Today the bridge feeds the gate
 * a synthetic 0/1 (`completionProbFromTurnEnd`), so this value is inert for any
 * threshold in (0, 1] and cannot disagree with the detector. When stage 2 threads the
 * classifier's REAL score to both, these become two independently-overridable knobs
 * thresholding the SAME probability: let them diverge and the detector can call a
 * pause `extended` while the gate reads it complete (or the reverse). Sharing this
 * default constant across the modules would NOT close that gap — runtime configs
 * still drift — and would couple this deliberately standalone gate to the detector
 * (this module imports nothing; see header). The question stage 2 must actually
 * settle is whether the two should collapse into ONE knob; that is left to stage 2,
 * not pre-judged here.
 */
export const DEFAULT_COMPLETION_THRESHOLD = 0.5;

export interface GateConfig {
  substantiveWords: number;
  acks: readonly string[];
  questionCooldownTurns: number;
  completionThreshold: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  substantiveWords: DEFAULT_SUBSTANTIVE_WORDS,
  acks: DEFAULT_ACKS,
  questionCooldownTurns: DEFAULT_QUESTION_COOLDOWN_TURNS,
  completionThreshold: DEFAULT_COMPLETION_THRESHOLD,
};

// ── Gate I/O ──

/** How the detector ended a turn — mirrors transcript.ts TurnEndMark.reason. */
export type TurnEndReason = 'floor' | 'extended';

/** A prior turn's decision — the history the escalate-slowly policy reads. */
export interface PriorDecision {
  /**
   * The UTTERANCE the decision was made about (`EvalContext.utteranceIndex`), so
   * the cooldown below measures spacing in thoughts. One utterance can contribute
   * several entries — one per evaluation the gate answered within it.
   */
  turn: number;
  tier: Tier;
}

/**
 * Everything the gate is allowed to look at when it evaluates a pause.
 *
 * This is deliberately WIDER than the policy below reads, and that is the point.
 * The gate's input used to be `endReason: 'floor' | 'extended'`, and rule 2 read
 * that one boolean as its ENTIRE B1 safety signal. The boolean existed only as a
 * SIDE EFFECT of smart-turn having extended the patience timer, so it threw away
 * the probability behind it, how long the pause had actually run, and how recently
 * the companion itself last spoke.
 *
 * Carrying the underlying signals instead is what makes the deferred stage 2 — let
 * the EOU verdict SHORTEN patience: reply sooner on a confident `complete`,
 * backchannel during a pause without taking the floor, grade restraint continuously
 * — a policy edit inside `decideTier` rather than a second round of state-machine
 * surgery. Every one of those is a decision INSIDE this module.
 *
 * STAGE 2 IS NOT AUTHORISED HERE. `decideTier` reproduces the previous behaviour
 * exactly; `msSinceSpeechEnd` and `msSinceWeLastSpoke` are carried but deliberately
 * UNREAD, and response-hierarchy.equivalence.test.ts pins that against a frozen copy
 * of the pre-refactor gate.
 */
export interface EvalContext {
  /**
   * Utterance identity (1-based) — which THOUGHT this is, not which evaluation tick
   * fired. The ack rotation and the question cooldown are spacing rules about
   * utterances, so they must not be keyed on a tick that can repeat within one
   * pause. su-lou.10.4 made the detector count the two separately (spec §4b), so
   * this is now the detector's `turn` — which advances only when the listener takes
   * the floor — while several `evaluate` ticks can share it. The contract here did
   * not change; only its source did, exactly as this field's original note promised.
   */
  utteranceIndex: number;
  /**
   * The WHOLE utterance transcribed so far — NOT the fragment since the last
   * evaluation. Rules 4/5 ask "how big is this thought?", so a re-evaluation of a
   * still-growing utterance has to see all of it. Empty ⇒ nothing was transcribed.
   *
   * This is what stops the companion CHIRPING mid-sentence once the floor is short:
   * fed the fragment after a declined pause, rule 4 reads a substantive thought as a
   * "brief turn" and backchannels over someone who is still talking.
   */
  utteranceTextSoFar: string;
  /**
   * The EOU classifier's P(complete) for this pause: the real number, not a boolean.
   * Below `GateConfig.completionThreshold` the classifier read the thinker as
   * mid-thought. Non-finite (no usable verdict) is treated as incomplete — see
   * rule 2; widening a two-valued reason into a real number admits NaN, and the
   * safe reading of "no EOU evidence" is to stay quiet.
   */
  completionProb: number;
  /**
   * How long this pause has run (ms since the last speech-end in the turn). `NaN`
   * when the turn had no speech-end to measure from (no segments at all) — the "no
   * measurement" sentinel, kept distinct from a real 0-length pause, and to be read
   * the same fail-safe way a non-finite `completionProb` is (above): no evidence ⇒
   * grant no license. Carried; unread in stage 1.
   */
  msSinceSpeechEnd: number;
  /**
   * How long since the companion last RELEASED THE FLOOR (ms), `Infinity` if it never
   * has. This is the detector's response-window close / barge-in — the moment it
   * handed the conversational turn back — NOT when its TTS audio literally stopped
   * (a clip can out- or under-run that window). That floor boundary is the meaningful
   * one for a restraint/spacing signal, not a stand-in for audio end. The signal the
   * gate could not previously see at all. Carried; unread in stage 1.
   */
  msSinceWeLastSpoke: number;
  /** The history the escalate-slowly policy reads. */
  priorDecisions: readonly PriorDecision[];
}

/**
 * `completionProb` for a caller that only has the detector's two-valued turn-end
 * reason.
 *
 * STAGE-1 BRIDGE. transcript.ts's `TurnEndMark` carries `reason`, not the score
 * behind it, so main.ts cannot yet hand the gate a real P(complete). `extended` ⇒
 * certainly incomplete, `floor` ⇒ certainly complete, which reproduces the old
 * rule-2 boolean exactly for any threshold in (0, 1]. Stage 2 deletes this and
 * threads the classifier's actual score through instead — at which point the gate
 * gains resolution without the contract changing again.
 */
export function completionProbFromTurnEnd(reason: TurnEndReason): number {
  return reason === 'extended' ? 0 : 1;
}

export interface GateDecision {
  tier: Tier;
  /** True iff this tier needs the LLM (reflection/question). silence/acknowledge are rules-only. */
  callModel: boolean;
  /** The rules-produced backchannel for `acknowledge`; undefined for every other tier. */
  ackText?: string;
  /** Why the gate landed here — shown in the UI/log and asserted by the tests. */
  reason: string;
}

/** Words in a turn, whitespace-split (matches reduced-role.js's count). */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// A finished thought that trails off on a discourse marker (ellipsis, em/en dash,
// comma) reads as "still going" — the thinker paused, they are not done. Same cue
// reduced-role.js holds on.
const TRAILING_OFF = /[…,\-—]$/;

/**
 * Decide the response tier for an evaluated pause under the "escalate slowly"
 * policy. Pure: same inputs → same output.
 *
 * Order matters — the restraint checks come FIRST so an unfinished thought can
 * never be escalated:
 *  1. no words                          → silence   (nothing to respond to)
 *  2. EOU says incomplete               → silence   (mid-thought; B1 — never interrupt)
 *  3. text trails off (…, — ,)          → silence   (mid-thought; the reduced-role cue)
 *  4. short finished aside              → acknowledge (rules-only rotating backchannel)
 *  5. substantive / a direct question   → reflection, or question when a question
 *                                          is EARNED (invited, or substantive after
 *                                          the cooldown and not the opening turn)
 *
 * These five rules, in this order, are the STAGE-1 policy: byte-for-byte the
 * behaviour that shipped before `EvalContext` widened the input contract. The extra
 * signals the context now carries are available to rules that do not exist yet.
 */
export function decideTier(ctx: EvalContext, config: Partial<GateConfig> = {}): GateDecision {
  const cfg: GateConfig = { ...DEFAULT_GATE_CONFIG, ...config };
  const text = ctx.utteranceTextSoFar.trim();
  const words = wordCount(text);
  const history = ctx.priorDecisions;

  // 1. Nothing transcribed — there is nothing to respond to.
  if (words === 0) {
    return { tier: 'silence', callModel: false, reason: 'no transcript — holding silence' };
  }

  // 2. The EOU classifier scored this pause below the completion threshold: the
  //    thinker is mid-thought. This is the audio+timing evidence a transcript gate
  //    lacks — previously reaching the gate only as the `extended` turn-end reason,
  //    i.e. as the side effect of that same comparison having lengthened the timer.
  //    B1 (usefulness bar): interrupting an unfinished thought is the cardinal
  //    failure. Hold silence regardless of what the words say.
  //
  //    Written as `!(prob >= threshold)` rather than `prob < threshold` so a
  //    non-finite probability — a verdict the classifier could not produce, which
  //    the old two-valued reason could not express — falls to silence rather than
  //    slipping through as "complete". Identical to `<` for every real number.
  //
  //    The wording below is preserved verbatim from the pre-widening gate: it is
  //    user-visible (the transcript's reply tooltip) and asserted by the equivalence
  //    tests, so stage 1 leaves it alone even though the gate now reads the score
  //    rather than the timer's reaction to it.
  if (!(ctx.completionProb >= cfg.completionThreshold)) {
    return { tier: 'silence', callModel: false, reason: 'detector held turn open (incomplete) — holding silence' };
  }

  // 3. The words trail off on a discourse marker — still going. Hold.
  if (TRAILING_OFF.test(text)) {
    return { tier: 'silence', callModel: false, reason: 'trailing off mid-thought — holding silence' };
  }

  // The turn is a finished thought. Decide the register.
  const invited = /\?/.test(text); // the thinker asked the companion something
  const substantive = words >= cfg.substantiveWords;

  // 4. A short, finished, non-question aside → minimal acknowledgment. Rules only,
  //    no model. Rotate the ack by turn number so a gated run doesn't stick.
  if (!invited && !substantive) {
    const ackText = cfg.acks[((ctx.utteranceIndex % cfg.acks.length) + cfg.acks.length) % cfg.acks.length];
    return { tier: 'acknowledge', callModel: false, ackText, reason: `brief turn (${words}w) — minimal acknowledgment` };
  }

  // 5. Substantive (or a direct question) → escalate to the LLM. Default to a
  //    reflection; grant the rare `question` rung only when it is EARNED, so that
  //    "most pauses should not become questions" holds:
  //      - a direct question from the thinker is answered in kind, OR
  //      - a substantive turn, past the opening turn, with the question cooldown
  //        elapsed since the last listener question (spacing → variety).
  const priorTurns = history.length;
  const lastQuestionTurn = history.reduce<number | null>(
    (acc, d) => (d.tier === 'question' ? (acc === null ? d.turn : Math.max(acc, d.turn)) : acc),
    null,
  );
  const sinceLastQuestion = lastQuestionTurn === null ? Infinity : ctx.utteranceIndex - lastQuestionTurn;
  const questionEarned =
    invited || (substantive && priorTurns >= 1 && sinceLastQuestion >= cfg.questionCooldownTurns);

  if (questionEarned) {
    return {
      tier: 'question',
      callModel: true,
      reason: invited ? 'thinker asked a question — one brief reply' : `substantive turn (${words}w), question cooldown elapsed`,
    };
  }
  return { tier: 'reflection', callModel: true, reason: `substantive turn (${words}w) — short reflection` };
}

// ── Prompt construction for the substantive tiers ──
//
// Only reflection/question turns reach the model. buildListenerRequest assembles
// the chat array the on-device LLM is generated against: the system prompt
// (prompts/chatgpt.md, carried in by the caller), a compact tier instruction that
// constrains the register, the running conversation, and the current turn. The
// history is threaded in listener POV (thinker → user, listener → assistant) and
// normalised exactly like promptfoo/providers/multi-turn.js `toProviderMessages`:
// empty (silent) turns dropped, consecutive same-role turns merged, so roles
// strictly alternate and no message is empty — the shape a chat model needs.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One prior exchange, in the order it happened. `text` empty ⇒ a silent listener turn (dropped). */
export interface ConversationTurn {
  speaker: 'thinker' | 'listener';
  text: string;
}

export interface ListenerRequest {
  messages: ChatMessage[];
  tier: Tier;
  /** Generation cap — reflections/questions are brief (a sentence or two). */
  maxNewTokens: number;
}

/** Default generation budget: a reflection/question is at most a sentence or two. */
export const DEFAULT_MAX_NEW_TOKENS = 64;

/** The register instruction appended to the system prompt for a substantive tier. */
export function tierInstruction(tier: Tier): string {
  switch (tier) {
    case 'reflection':
      return (
        'For THIS reply: offer at most a short, momentum-preserving reflection — a ' +
        'sentence or two that nudges the thought a little further. Do NOT ask a ' +
        'question. Often the best reply is still nothing.'
      );
    case 'question':
      return (
        'For THIS reply: you may offer exactly ONE brief follow-up question, ' +
        'anchored to something specific they just said — never a generic stem. Keep ' +
        'it to a single sentence, or stay silent if nothing specific is worth pulling on.'
      );
    // silence / acknowledge never call the model; return no extra instruction.
    default:
      return '';
  }
}

/**
 * Normalise conversation turns into an alternating chat array with `system`
 * prepended: drop empty turns, merge consecutive same-role turns with a blank
 * line. Mirrors multi-turn.js `toProviderMessages`.
 */
export function toChatMessages(systemContent: string, turns: readonly ConversationTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: systemContent }];
  for (const t of turns) {
    const content = t.text.trim();
    if (!content) continue; // drop silent listener turns
    const role: 'user' | 'assistant' = t.speaker === 'thinker' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  return out;
}

/**
 * Build the LLM request for a substantive turn. `history` is the prior
 * conversation (not including the current turn); `currentTurnText` is appended as
 * the final thinker (user) message.
 */
export function buildListenerRequest(params: {
  systemPrompt: string;
  tier: Tier;
  currentTurnText: string;
  history?: readonly ConversationTurn[];
  maxNewTokens?: number;
}): ListenerRequest {
  const system = `${params.systemPrompt.trim()}\n\n${tierInstruction(params.tier)}`.trim();
  const turns: ConversationTurn[] = [
    ...(params.history ?? []),
    { speaker: 'thinker', text: params.currentTurnText },
  ];
  return {
    messages: toChatMessages(system, turns),
    tier: params.tier,
    maxNewTokens: params.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
  };
}
