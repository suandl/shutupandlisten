// Reduced-role listener provider.
//
// Subclasses providers/multi-turn.js and overrides ONLY the _listenerTurn
// seam. It models the "reduced role" (CONCEPTS.md): the endpointing + rules
// layer handles silence and acknowledgments, and the text-LLM is invoked only
// for substantive replies — lowering the bar a small on-device model must
// clear. Everything else (the simulator loop, usage/cost accounting,
// transcript formatting, targetConfig passthrough) is inherited unchanged, so
// a full-brain cell and its reduced-role twin differ by exactly this gate.
//
// What the gate emits for a light turn is a NATURAL minimal acknowledgment
// ("mm", "yeah") — hierarchy level 2 — not a "[silence]" sentinel. The judges
// score transcript text; a real backchannel is what a restrained listener
// actually utters and is what restraint.txt rewards, whereas a bracketed
// sentinel is a token the rubrics were never written to read.
//
// UPPER-BOUND CAVEAT: the live gate (U5) routes on audio + timing
// (silence-duration buckets, smart-turn EOU). A transcript exposes none of
// that, so this text gate keys on the text-derivable subset — an explicit
// question cue, trailing-off discourse markers, and utterance length. The
// reduced-role score it produces is therefore an UPPER BOUND on live routing
// accuracy; U5 measures the live-gate-vs-text-gate gap. The banned-phrase
// avoid-list is intentionally NOT duplicated here: it lives in
// prompts/chatgpt.md (carried into the model call) and judges/restraint.txt
// (scored), and the gate never emits prose, so a third copy would only drift.
//
// Config (in addition to everything multi-turn.js accepts):
//   acks                 (optional) array of minimal acks to rotate through.
//                                   Default ["mm","yeah","mhm","right","mm-hm"].
//   gateSubstantiveWords (optional) word count at/above which a non-question,
//                                   non-trailing-off thinker turn counts as
//                                   substantive and escalates to the model.
//                                   Default 12. The primary reduced-role knob;
//                                   the findings methodology sweeps it.

const MultiTurnProvider = require('./multi-turn.js');
// The routing rules live in lib/gate.js so providers/replay.js gates fixture
// turns with the SAME rules — one gate, two callers, no drift. Behaviour is
// byte-identical to when the rules lived here (pinned by
// test/reduced-role.test.js).
const {
  DEFAULT_ACKS,
  DEFAULT_SUBSTANTIVE_WORDS,
  shouldEscalate,
  ackFor,
  latestThinkerTurn,
} = require('../lib/gate.js');

class ReducedRoleProvider extends MultiTurnProvider {
  constructor(options) {
    super(options);
    const config = (options && options.config) || {};
    this.acks =
      Array.isArray(config.acks) && config.acks.length ? config.acks : DEFAULT_ACKS;
    this.gateSubstantiveWords =
      Number(config.gateSubstantiveWords) || DEFAULT_SUBSTANTIVE_WORDS;
  }

  // The latest thinker turn is the last role:'user' entry in the listener-POV
  // transcript (user = thinker, assistant = listener). Thin wrappers over
  // lib/gate.js, kept as methods so the seam (and its unit tests) stay stable.
  _latestThinkerTurn(transcript) {
    return latestThinkerTurn(transcript);
  }

  // Text-only response-hierarchy gate. Returns true to escalate to the model
  // (levels 3-4: reflection / brief question), false to answer with a minimal
  // ack (levels 1-2). Default is silence/ack; it escalates only on positive
  // evidence a substantive reply is invited. Rules in lib/gate.js.
  _shouldEscalate(thinkerText) {
    return shouldEscalate(thinkerText, this.gateSubstantiveWords);
  }

  async _listenerTurn(args) {
    const latestThinker = this._latestThinkerTurn(args.transcript);
    if (this._shouldEscalate(latestThinker)) {
      // Substantive turn: defer to the model via the inherited listener call.
      return super._listenerTurn(args);
    }
    // Light turn: answer from the gate with NO model call.
    return { text: ackFor(args.turn, this.acks), tokenUsage: null, cost: 0, modelCalled: false };
  }
}

module.exports = ReducedRoleProvider;
