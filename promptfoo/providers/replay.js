// Fixture-replay provider — a captured real session drives the thinker side.
//
// The multi-turn provider's thinker is a simulator, and the simulator emits
// clean prose — docs/findings/on-device-text-quality.md §5–6 calls the result
// a CLEAN-TEXT UPPER BOUND: every judge score flatters the listener relative
// to live disfluent STT input, and the reduced-role gate (which keys on
// punctuation / discourse-marker cues) escalates nearly every clean turn.
// This provider closes the loop from the other end: it replays the thinker
// utterances of a CAPTURED session — real iOS SFSpeechRecognizer output,
// exported to the fixture schema in fixtures/README.md — verbatim against the
// listener under test. No simulator calls at all: the thinker side is fully
// deterministic (and free), so a score delta between two runs of the same
// replay cell can only come from the listener.
//
// The output contract is EXACTLY the multi-turn provider's: a
// "THINKER: …\n\nLISTENER: …" transcript with LANDING_MARKER after the turn
// that ends the dictation (the fixture's landingIndex, defaulting to the last
// utterance), formatted by the same formatTranscript(). All four judges —
// probing-depth, restraint, no-summarize, variety — run unchanged, and cannot
// tell a replay cell from a simulator cell by format.
//
// One deliberate difference from multi-turn.js: the prompt template's user
// message (the scenario's starting_turn) is IGNORED. The fixture replaces the
// entire thinker side — splicing a scenario opener in front of a captured
// session would produce a conversation nobody ever had. Only the system
// message (the listener prompt under test) is read. Consequently every
// scenario yields the same replay conversation for a given prompt; filter to
// one scenario (see eval:smoke:replay) to avoid paying for duplicate cells.
//
// Replay is NOT limited to the fixture's own knob settings: the optional gate
// mode re-routes the SAME captured turns through the reduced-role rules
// (lib/gate.js — the identical module providers/reduced-role.js uses), so one
// capture can score both full-brain and reduced-role listeners. With real
// disfluent turns the gate finally has something to ack — the harness's 4/4
// model_calls finding is a clean-prose artifact (§5).
//
// Config (plus targetModel / targetConfig, inherited from multi-turn.js):
//   fixturePath          (required) path to a fixture JSON (schema:
//                                   lib/fixture-schema.js, documented in
//                                   fixtures/README.md), relative to the
//                                   promptfoo config dir (basePath).
//   gate                 (optional) true → answer light turns from the
//                                   reduced-role rules gate with a no-model
//                                   ack; listenerModelCalls in the metadata
//                                   then reports how many turns actually hit
//                                   the model (same signal as reduced-role).
//   acks                 (optional) gate mode: acks to rotate through.
//   gateSubstantiveWords (optional) gate mode: escalation word count
//                                   (default 12, same as reduced-role).
//
// simulatorModel / maxTurns / simulatorSystemPath / disfluency are accepted
// (the constructor is inherited) but unused: there is no simulator, the turn
// count is the fixture's, and the fixture text is already genuinely disfluent
// — layering synthetic noise on a capture would double-count.

const fs = require('fs');
const path = require('path');

const MultiTurnProvider = require('./multi-turn.js');
const { formatTranscript, accumulateUsage } = MultiTurnProvider;
const { validateFixture } = require('../lib/fixture-schema.js');
const {
  DEFAULT_ACKS,
  DEFAULT_SUBSTANTIVE_WORDS,
  shouldEscalate,
  ackFor,
  latestThinkerTurn,
} = require('../lib/gate.js');

class ReplayProvider extends MultiTurnProvider {
  constructor(options) {
    super(options);
    const config = (options && options.config) || {};

    if (!config.fixturePath) {
      throw new Error(
        'replay provider: config.fixturePath is required (a fixture JSON per fixtures/README.md)',
      );
    }
    this.fixturePath = config.fixturePath;
    if (!(options && options.id)) {
      this.providerId = `replay:${config.targetModel}:${config.fixturePath}`;
    }

    this.gate = Boolean(config.gate);
    this.acks =
      Array.isArray(config.acks) && config.acks.length ? config.acks : DEFAULT_ACKS;
    this.gateSubstantiveWords =
      Number(config.gateSubstantiveWords) || DEFAULT_SUBSTANTIVE_WORDS;

    this._fixture = null;
  }

  // Load + schema-check the fixture once. A malformed fixture fails loudly
  // with every violation listed — a silently truncated export must never
  // masquerade as a short session. Seam: tests inject a fixture object here.
  _loadFixture() {
    if (this._fixture) return this._fixture;
    const fullPath = path.isAbsolute(this.fixturePath)
      ? this.fixturePath
      : path.resolve(this.basePath, this.fixturePath);
    const fixture = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const errors = validateFixture(fixture);
    if (errors.length) {
      throw new Error(
        `replay provider: fixture ${this.fixturePath} fails schema check:\n  ${errors.join('\n  ')}`,
      );
    }
    this._fixture = fixture;
    return this._fixture;
  }

  async callApi(prompt, context) {
    await this._ensureProviders();

    let messages;
    try {
      messages = JSON.parse(prompt);
    } catch (err) {
      return {
        error: `replay provider: prompt must be a JSON chat array; parse failed: ${err.message}`,
      };
    }
    const listenerSystem = messages.find((m) => m.role === 'system')?.content;
    if (!listenerSystem) {
      return {
        error:
          'replay provider: prompt must contain a system message (the listener prompt under test)',
      };
    }
    // Any user message in the template (the scenario's starting_turn) is
    // ignored on purpose — see the header. The fixture IS the thinker.

    let fixture;
    try {
      fixture = this._loadFixture();
    } catch (err) {
      return { error: err.message };
    }
    const utterances = fixture.utterances;
    const landingUtterance = Number.isInteger(fixture.landingIndex)
      ? fixture.landingIndex
      : utterances.length - 1;

    // Same shape as multi-turn.js: listener-POV transcript (user = thinker,
    // assistant = listener), alternating thinker → listener so the listener
    // responds to every captured utterance with full conversation history.
    const transcript = [];
    const usage = { total: 0, prompt: 0, completion: 0, numRequests: 0 };
    let cost = 0;
    let modelCalls = 0;

    for (let i = 0; i < utterances.length; i += 1) {
      transcript.push({ role: 'user', content: String(utterances[i].text) });
      const listenerTurn = await this._listenerTurn({
        listenerSystem,
        transcript,
        context,
        turn: i,
      });
      if (listenerTurn.error) {
        return { error: listenerTurn.error };
      }
      transcript.push({ role: 'assistant', content: listenerTurn.text });
      accumulateUsage(usage, listenerTurn.tokenUsage);
      cost += listenerTurn.cost || 0;
      if (listenerTurn.modelCalled !== false) modelCalls += 1;
    }

    // Thinker utterance k sits at transcript index 2k (thinker turns are the
    // even entries), so the landing marker lands right after the utterance the
    // fixture named — the same positional anchoring multi-turn.js uses.
    const landingIndex = landingUtterance * 2;

    return {
      output: formatTranscript(transcript, landingIndex),
      tokenUsage: usage,
      cost,
      metadata: {
        turns: transcript.length,
        listenerTurns: transcript.filter((m) => m.role === 'assistant').length,
        thinkerTurns: transcript.filter((m) => m.role === 'user').length,
        listenerModelCalls: modelCalls,
        // Provenance travels with the result: a hand-authored placeholder and
        // a real device capture must never be readable as the same evidence.
        fixture: {
          path: this.fixturePath,
          id: fixture.session.id,
          source: fixture.session.source,
        },
      },
    };
  }

  // Gate mode: route each captured turn through the SAME rules gate the
  // reduced-role provider uses (lib/gate.js). Off → every turn goes to the
  // model, exactly like the base _listenerTurn.
  async _listenerTurn(args) {
    if (!this.gate) return super._listenerTurn(args);
    if (shouldEscalate(latestThinkerTurn(args.transcript), this.gateSubstantiveWords)) {
      return super._listenerTurn(args);
    }
    return { text: ackFor(args.turn, this.acks), tokenUsage: null, cost: 0, modelCalled: false };
  }
}

module.exports = ReplayProvider;
