// STT-style disfluency layer — a deterministic, seeded transform over thinker text.
//
// WHY THIS EXISTS. The thinker simulator emits clean prose, and
// docs/findings/on-device-text-quality.md §5–6 names the cost: every judge
// score is a CLEAN-TEXT UPPER BOUND relative to live disfluent STT output, and
// the reduced-role gate — which keys on punctuation / discourse-marker cues
// (`?`, `…`, `—`, `,`) and word count — escalates nearly every clean-prose turn
// (the 4/4 model_calls finding). Real dictation from iOS SFSpeechRecognizer is
// filler-ridden, restart-prone, and punctuation-poor, so disfluent input moves
// BOTH listener quality AND gate routing. This module makes that measurable
// without waiting for device captures: it injects STT-shaped noise into the
// simulator's thinker turns (opt-in on providers/multi-turn.js and
// providers/reduced-role.js) so a disfluent cell can sit next to its clean
// twin in the same matrix.
//
// DETERMINISM IS THE CONTRACT. Same (text, seed, level) → same output, byte for
// byte, so a disfluent cell is reproducible across runs and machines and a
// score delta between two runs can never be "the noise rolled differently".
// All randomness comes from an inline mulberry32 PRNG seeded from the config —
// never Math.random. Providers surface the seed in result metadata so a
// transcript can always be traced back to its noise.
//
// WHAT IT DOES (all noise, no meaning):
//   * injects fillers ("um", "uh", "like", "you know", "I mean") at word gaps
//   * occasionally repeats a word or restarts a short phrase ("it plans it
//     plans meals")
//   * strips most terminal punctuation and some commas — including some
//     question marks, which is exactly the cue the reduced-role gate keys on
//   * lowercases sentence starts (STT casing is erratic)
//   * lets stripped sentence ends run on, sometimes gluing them with a bare
//     "and" / "so" discourse connector
//
// OUT OF SCOPE (v1, on purpose): mis-transcription simulation. No word is ever
// substituted, dropped, or reordered — every original word survives, in order
// (test/disfluency.test.js pins this as a subsequence invariant). Swapping
// words would change what the thinker SAID, and the judges score the listener
// against the thinker's actual content; semantic damage would make a low
// probing-depth score unreadable (bad listener, or mangled input?). Real STT
// does mis-transcribe — modeling that honestly needs device captures (see
// fixtures/), not a random word table.

// Named levels map to a single 0–1 strength that scales every per-site
// probability below. A numeric level in [0, 1] is accepted too. Strength 0 is
// the identity: the input string is returned untouched.
const LEVELS = { light: 0.3, medium: 0.6, heavy: 1.0 };

// Discourse-only insertions. Fillers ride mid-stream; connectors glue a
// sentence whose terminal period was stripped onto the next one (run-on).
// Neither carries propositional content, so meaning is preserved.
const FILLERS = ['um', 'uh', 'like', 'you know', 'I mean'];
const CONNECTORS = ['and', 'so'];

// Small, well-known 32-bit PRNG. Inline (no dependency) and seeded, so the
// whole transform is a pure function of (text, seed, level).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Resolve a level (named or numeric 0–1) to a strength scalar. Loud on an
// unknown name: a typo'd "mediun" silently treated as anything would make two
// cells incomparable without anyone noticing.
function resolveLevel(level) {
  if (level == null) return LEVELS.medium;
  if (typeof level === 'number') {
    if (!Number.isFinite(level) || level < 0 || level > 1) {
      throw new Error(`disfluency: numeric level must be in [0, 1], got ${level}`);
    }
    return level;
  }
  const named = LEVELS[String(level).toLowerCase()];
  if (named === undefined) {
    throw new Error(
      `disfluency: unknown level "${level}" (use ${Object.keys(LEVELS).join('/')} or a number in [0, 1])`,
    );
  }
  return named;
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

// A token stripped to the bare word (no trailing clause punctuation), for
// repeats/restarts — "meals," restarts as "meals meals," not "meals, meals,".
// Pure-punctuation tokens (a lone "—") yield '' so they are never re-said: a
// doubled dash is typography, not a disfluency.
function bareWord(token) {
  const stripped = token.replace(/[.,!?…;:]+$/u, '');
  return /[\p{L}\p{N}]/u.test(stripped) ? stripped : '';
}

// Keep "I", "I'm", "I've", … uppercase even at a lowered sentence start — STT
// reliably capitalizes the pronoun, so lowering it would read as a typo, not
// as dictation.
function lowerFirst(token) {
  if (/^I(?:['’]|$)/.test(token)) return token;
  return token.charAt(0).toLowerCase() + token.slice(1);
}

// Transform `text` into an STT-flavoured rendition. Pure and deterministic:
// same (text, seed, level) → same output. Level 0 (or empty input) returns the
// input string unchanged, byte for byte.
function applyDisfluency(text, options = {}) {
  const strength = resolveLevel(options.level);
  const input = String(text ?? '');
  if (strength <= 0 || !input.trim()) return input;

  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 1;
  const rand = mulberry32(seed);

  const tokens = input.split(/\s+/).filter(Boolean);
  const out = [];
  // The first token of the text starts a sentence; afterwards a token starts a
  // sentence iff the ORIGINAL previous token ended one — stripping the period
  // must not stop the next word from being lowercased, that pairing is what
  // produces the run-on.
  let atSentenceStart = true;

  for (const original of tokens) {
    // Filler at this word gap (never before the very first word — dictation
    // openers like "OK so" are already the fixture/simulator's job).
    if (out.length > 0 && rand() < 0.09 * strength) {
      out.push(pick(rand, FILLERS));
    } else if (out.length >= 2 && rand() < 0.04 * strength) {
      // Phrase restart: re-say the last one or two bare words ("so the app is
      // really is really a queue").
      const span = rand() < 0.5 ? 1 : 2;
      const restart = out.slice(-span).map(bareWord).filter(Boolean);
      out.push(...restart);
    }

    let token = original;
    if (atSentenceStart && rand() < 0.9 * strength) token = lowerFirst(token);

    // Single-word stutter ("the the ordering").
    if (rand() < 0.03 * strength && bareWord(token)) {
      out.push(bareWord(token));
    }

    // Terminal punctuation. Periods/exclamations go most of the time; question
    // marks sometimes (dropping the gate's strongest escalation cue is part of
    // the point); commas about half the time at full strength.
    let stripped = false;
    if (/[.!]$/.test(token) && rand() < 0.85 * strength) {
      token = token.replace(/[.!]+$/, '');
      stripped = true;
    } else if (/\?$/.test(token) && rand() < 0.35 * strength) {
      token = token.replace(/\?+$/, '');
      stripped = true;
    } else if (/,$/.test(token) && rand() < 0.5 * strength) {
      token = token.replace(/,+$/, '');
    }
    out.push(token);

    // A stripped sentence end occasionally gets a bare connector, turning two
    // sentences into one spoken run-on.
    const endedSentence = /[.!?]$/.test(original);
    if (stripped && endedSentence && rand() < 0.25 * strength) {
      out.push(pick(rand, CONNECTORS));
    }
    atSentenceStart = endedSentence;
  }

  return out.join(' ');
}

module.exports = { applyDisfluency, resolveLevel, mulberry32, LEVELS, FILLERS, CONNECTORS };
