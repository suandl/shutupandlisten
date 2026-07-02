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
// gate does not: the detector's turn-end reason (smart-turn EOU / patience veto) —
// exactly the "live-gate-vs-text-gate gap" that reduced-role.js's header flags.
//
// PURE — no DOM, no model, no I/O. `decideTier` is a `(turn, history) -> decision`
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

export interface GateConfig {
  substantiveWords: number;
  acks: readonly string[];
  questionCooldownTurns: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  substantiveWords: DEFAULT_SUBSTANTIVE_WORDS,
  acks: DEFAULT_ACKS,
  questionCooldownTurns: DEFAULT_QUESTION_COOLDOWN_TURNS,
};

// ── Gate I/O ──

/** How the detector ended a turn — mirrors transcript.ts TurnEndMark.reason. */
export type TurnEndReason = 'floor' | 'extended';

/** The just-completed turn the gate decides on. */
export interface GateTurn {
  /** Detector turn number (1-based). */
  turn: number;
  /** The turn's transcribed text (joined segments). Empty ⇒ nothing was transcribed. */
  text: string;
  /**
   * How the detector ended the turn:
   *  - 'floor'    — ended at the bare patience floor: a clean finish.
   *  - 'extended' — smart-turn read the pause as INCOMPLETE and held the floor
   *                 open; the thinker was mid-thought. The audio+timing signal a
   *                 transcript gate lacks; it biases hard toward silence (B1).
   */
  endReason: TurnEndReason;
}

/** A prior turn's decision — the history the escalate-slowly policy reads. */
export interface PriorDecision {
  turn: number;
  tier: Tier;
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
 * Decide the response tier for a completed turn under the "escalate slowly"
 * policy. Pure: same inputs → same output.
 *
 * Order matters — the restraint checks come FIRST so an unfinished thought can
 * never be escalated:
 *  1. no words                          → silence   (nothing to respond to)
 *  2. detector held the turn (extended) → silence   (mid-thought; B1 — never interrupt)
 *  3. text trails off (…, — ,)          → silence   (mid-thought; the reduced-role cue)
 *  4. short finished aside              → acknowledge (rules-only rotating backchannel)
 *  5. substantive / a direct question   → reflection, or question when a question
 *                                          is EARNED (invited, or substantive after
 *                                          the cooldown and not the opening turn)
 */
export function decideTier(
  turn: GateTurn,
  history: readonly PriorDecision[] = [],
  config: Partial<GateConfig> = {},
): GateDecision {
  const cfg: GateConfig = { ...DEFAULT_GATE_CONFIG, ...config };
  const text = turn.text.trim();
  const words = wordCount(text);

  // 1. Nothing transcribed — there is nothing to respond to.
  if (words === 0) {
    return { tier: 'silence', callModel: false, reason: 'no transcript — holding silence' };
  }

  // 2. The detector held the turn open past the floor: smart-turn read the pause
  //    as incomplete. This is the audio+timing evidence the thinker is mid-thought.
  //    B1 (usefulness bar): interrupting an unfinished thought is the cardinal
  //    failure. Hold silence regardless of what the words say.
  if (turn.endReason === 'extended') {
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
    const ackText = cfg.acks[((turn.turn % cfg.acks.length) + cfg.acks.length) % cfg.acks.length];
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
  const sinceLastQuestion = lastQuestionTurn === null ? Infinity : turn.turn - lastQuestionTurn;
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
