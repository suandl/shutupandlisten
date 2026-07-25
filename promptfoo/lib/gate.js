// Text-only response-hierarchy gate — shared routing rules.
//
// Factored out of providers/reduced-role.js so providers/replay.js can gate
// fixture-replayed thinker turns with the SAME rules the reduced-role cells
// use — one gate, two callers, no drift. The behaviour is byte-identical to
// the pre-factoring reduced-role gate (pinned by test/reduced-role.test.js).
//
// The gate models the "reduced role" (CONCEPTS.md): the endpointing + rules
// layer handles silence and acknowledgments (response-hierarchy levels 1–2),
// and the text-LLM is invoked only for substantive turns. A transcript exposes
// none of the live gate's audio/timing signals, so this text gate keys on the
// text-derivable subset — an explicit question cue, trailing-off discourse
// markers, and utterance length — making its routing an UPPER BOUND on live
// accuracy (see the header of providers/reduced-role.js).

// Natural level-2 minimal acknowledgments, rotated by turn index so a run of
// gated turns doesn't read as one stuck token.
const DEFAULT_ACKS = ['mm', 'yeah', 'mhm', 'right', 'mm-hm'];
const DEFAULT_SUBSTANTIVE_WORDS = 12;

// Decide whether a thinker turn escalates to the model (levels 3–4:
// reflection / brief question) or is answered with a minimal ack (levels 1–2).
// Default is silence/ack; it escalates only on positive evidence a substantive
// reply is invited.
function shouldEscalate(thinkerText, substantiveWords = DEFAULT_SUBSTANTIVE_WORDS) {
  const text = String(thinkerText || '').trim();
  if (!text) return false;
  // Explicit question → a substantive reply is invited (level 4).
  if (/\?/.test(text)) return true;
  // Trailing off mid-thought (ellipsis, em-dash, comma) → the thinker isn't
  // done; hold and acknowledge, never treat the pause as a finished thought.
  if (/[…,—-]$/.test(text)) return false;
  // Otherwise escalate only on a genuinely substantive utterance.
  const words = text.split(/\s+/).filter(Boolean).length;
  return words >= substantiveWords;
}

// The ack for a gated turn: rotate through the list by turn index.
function ackFor(turn, acks = DEFAULT_ACKS) {
  return acks[turn % acks.length];
}

// The latest thinker turn is the last role:'user' entry in the listener-POV
// transcript (user = thinker, assistant = listener).
function latestThinkerTurn(transcript) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].role === 'user') return transcript[i].content;
  }
  return '';
}

module.exports = {
  DEFAULT_ACKS,
  DEFAULT_SUBSTANTIVE_WORDS,
  shouldEscalate,
  ackFor,
  latestThinkerTurn,
};
