// Multi-turn simulator-driven provider.
//
// Replaces promptfoo's single-shot test loop with a 4-6 turn conversation
// per scenario. The "listener" is the system under test (one of the prompts
// from ../prompts/, run on `targetModel`). The "thinker" is driven by the
// user-simulator system prompt at `simulatorSystemPath` (default
// simulators/thinker.md), parameterised with the scenario's `topic` and
// `idea_arc` (read from `context.test.metadata`).
//
// The provider returns the full transcript as a single string formatted as
// "THINKER: ...\n\nLISTENER: ...\n\n...". All four judges score against
// this transcript.
//
// THE DICTATION HAS TO END. judges/restraint.txt scores a TRANSITION — silence
// while the idea is being laid out, then at most one thread-pull once it lands.
// A simulator that dictates across every turn never reaches that transition, so
// every listener turn is mid-dictation by construction and no transcript can
// score above the over-engagement band whatever the prompt, provider or model
// does. That is not a strict judge, it is an unmeasurable column: it read
// 0-of-16 on the first full run and, because a cell passes only when every
// judge passes, it forced 0-of-16 overall and hid movement everywhere else
// (su-lou.12). The loop therefore ends the dictation on purpose:
//
//   * every simulator call carries a PHASE directive, and the LAST one is a
//     LANDING directive — finish the idea and come to a natural stopping point
//     — so the final thinker turn ENDS the dictation instead of extending it;
//   * the formatted transcript carries LANDING_MARKER right after that turn, so
//     judges anchor "mid-dictation" vs "after the idea landed" on a fixed line
//     rather than guessing where the thinker stopped.
//
// The marker is added at FORMAT time only. It never enters the message arrays
// sent to the listener or the simulator, so it cannot cue the system under test
// that its window has opened — the listener still has to read the landing out
// of the thinker's own words, which is exactly the product behaviour under test.
//
// Why a custom JS provider (vs. promptfoo redteam strategies): the redteam
// strategies are shaped around adversarial probing — turn budgets, refusal
// detection, jailbreak rubrics. A cooperative simulator is closer to a
// plain conversation runner, so a small custom provider is cleaner than
// repurposing the adversarial machinery.
//
// Provider config (see promptfooconfig.yaml):
//   targetModel          (required) promptfoo provider string for the
//                                   listener, e.g. "openai:gpt-4o".
//   simulatorModel       (optional) provider string for the thinker.
//                                   Defaults to targetModel. Pin to a single
//                                   model across cells for apples-to-apples
//                                   listener comparison.
//   maxTurns             (optional) number of LISTENER turns. The loop
//                                   alternates listener -> thinker and
//                                   always ends on a listener turn, so the
//                                   transcript has maxTurns listener turns
//                                   and maxTurns thinker turns (including
//                                   the starting turn). Default 5.
//   simulatorSystemPath  (optional) path to the simulator system prompt,
//                                   relative to the promptfoo config dir
//                                   (basePath). Default
//                                   "simulators/thinker.md".
//   targetConfig         (optional) provider-config object passed ONLY to the
//                                   listener provider (via loadApiProvider's
//                                   options.config), e.g. {apiBaseUrl, apiKey}
//                                   to point an OpenAI-compatible target at a
//                                   local on-device server (mlx_lm.server,
//                                   llama-server). Deliberately NOT a global
//                                   OPENAI_BASE_URL: a global base URL would
//                                   also redirect the pinned cloud simulator
//                                   and the llm-rubric judges. Scoping it to
//                                   the listener keeps the thinker and judges
//                                   on their real endpoints.
//   disfluency           (optional) opt-in STT-style noise on the thinker
//                                   side, e.g. { seed: 42, level: "medium" }
//                                   (see lib/disfluency.js). The simulator
//                                   still writes clean prose; the transform is
//                                   applied to every thinker turn — the
//                                   scenario's starting turn included — before
//                                   it reaches the listener AND before it is
//                                   written to the transcript, so the judges
//                                   score exactly what the listener saw. This
//                                   closes on the clean-text upper bound of
//                                   docs/findings/on-device-text-quality.md
//                                   §5–6: clean prose flatters listener scores
//                                   and makes the reduced-role gate escalate
//                                   nearly every turn. ABSENT MEANS OFF, and
//                                   off is byte-for-byte identical to before
//                                   the option existed. `seed` (default 1) is
//                                   reported in result metadata; each thinker
//                                   turn uses seed + its turn index so noise
//                                   decorrelates across turns while staying
//                                   fully reproducible.
//
// Subclassing: the per-turn listener call is isolated in the _listenerTurn()
// seam so a subclass (see providers/reduced-role.js) can answer light turns
// from a rules gate without a model call, while reusing the whole simulator
// loop, usage/cost accounting, and transcript formatting unchanged.
// providers/replay.js reuses the same seam plus formatTranscript() with the
// simulator loop replaced by a captured-session fixture.

const fs = require('fs');
const path = require('path');

const { applyDisfluency, resolveLevel } = require('../lib/disfluency.js');

// Emitted into the formatted transcript directly after the thinker turn that
// lands the idea. Self-describing on purpose: every judge reads this same
// transcript, so the line has to explain itself to a rubric that was never told
// a marker existed. judges/restraint.txt anchors its mid-dictation vs.
// post-landing split on this exact string (pinned by
// test/landing-phase.test.js).
const LANDING_MARKER =
  '[THE THINKER HAS NOW FINISHED LAYING OUT THE IDEA — anything below this line is after the idea landed]';

// Phase directive appended to the simulator's system prompt for ONE call.
// `call` is the 0-based simulator-call index; `totalCalls` is how many the run
// makes (maxTurns - 1). The arc in simulators/thinker.md already asks the
// thinker to reach a stopping point, but nothing told it WHEN — so it kept
// dictating to the turn budget. The last call now says so explicitly.
function phaseDirective(call, totalCalls) {
  if (call >= totalCalls - 1) {
    return [
      'PHASE — LANDING. This is your LAST turn: finish laying the idea out and',
      'come to a natural stopping point. Say the final piece and close it off',
      "(“…so that's basically the idea”). Do not open a new thread, and do",
      'not ask the listener a question.',
    ].join('\n');
  }
  if (call === totalCalls - 2) {
    return [
      'PHASE — CONVERGING. You are near the end of the arc: start bringing the',
      'idea together. You will finish laying it out on your next turn.',
    ].join('\n');
  }
  return [
    'PHASE — DEVELOPING. You are still laying the idea out: carry it forward',
    'through the next stage of the arc. Do not wrap up yet.',
  ].join('\n');
}

class MultiTurnProvider {
  constructor(options) {
    const opts = options || {};
    const config = opts.config || {};

    if (!config.targetModel) {
      throw new Error(
        'multi-turn provider: config.targetModel is required (e.g. "openai:gpt-4o")',
      );
    }

    this.providerId = opts.id || `multi-turn:${config.targetModel}`;
    this.label = opts.label;
    this.targetModel = config.targetModel;
    // Provider-config passthrough for the listener only (e.g. apiBaseUrl /
    // apiKey for an OpenAI-compatible local server). Never applied globally,
    // so the cloud simulator and judges are unaffected. See header note.
    this.targetConfig = config.targetConfig || null;
    this.simulatorModel = config.simulatorModel || config.targetModel;
    this.maxTurns = Number(config.maxTurns) || 5;
    this.simulatorSystemPath = config.simulatorSystemPath || 'simulators/thinker.md';
    // basePath is injected by promptfoo and points at the config dir.
    this.basePath = config.basePath || process.cwd();
    // Opt-in disfluency layer. Normalized here (and the level resolved
    // eagerly, so a typo'd level fails at construction, not mid-eval); null
    // when absent — and absent MUST mean byte-identical behaviour.
    if (config.disfluency) {
      const d = config.disfluency;
      resolveLevel(d.level); // validate now; applyDisfluency re-resolves per call
      this.disfluency = {
        seed: Number.isFinite(d.seed) ? Math.floor(d.seed) : 1,
        level: d.level == null ? 'medium' : d.level,
      };
    } else {
      this.disfluency = null;
    }

    this._listener = null;
    this._simulator = null;
    this._simulatorSystem = null;
  }

  id() {
    return this.providerId;
  }

  toString() {
    return this.label || this.providerId;
  }

  async _ensureProviders() {
    if (this._listener && this._simulator) return;
    const promptfoo = await import('promptfoo');
    const loadApiProvider = promptfoo.loadApiProvider || promptfoo.default?.loadApiProvider;
    if (typeof loadApiProvider !== 'function') {
      throw new Error('multi-turn provider: could not resolve promptfoo.loadApiProvider');
    }
    // Pass targetConfig (if any) ONLY to the listener provider. The simulator
    // and judges load without it, so a local-server apiBaseUrl here never
    // leaks onto the pinned cloud thinker or the rubric judges.
    this._listener = this.targetConfig
      ? await loadApiProvider(this.targetModel, { options: { config: this.targetConfig } })
      : await loadApiProvider(this.targetModel);
    this._simulator =
      this.simulatorModel === this.targetModel
        ? this._listener
        : await loadApiProvider(this.simulatorModel);
  }

  _loadSimulatorSystem() {
    if (this._simulatorSystem) return this._simulatorSystem;
    const fullPath = path.isAbsolute(this.simulatorSystemPath)
      ? this.simulatorSystemPath
      : path.resolve(this.basePath, this.simulatorSystemPath);
    this._simulatorSystem = fs.readFileSync(fullPath, 'utf8');
    return this._simulatorSystem;
  }

  async callApi(prompt, context) {
    await this._ensureProviders();

    let messages;
    try {
      messages = JSON.parse(prompt);
    } catch (err) {
      return {
        error: `multi-turn provider: prompt must be a JSON chat array; parse failed: ${err.message}`,
      };
    }

    const listenerSystem = messages.find((m) => m.role === 'system')?.content;
    const startingTurn = messages.find((m) => m.role === 'user')?.content;
    if (!listenerSystem || !startingTurn) {
      return {
        error:
          'multi-turn provider: prompt must contain both a system message (listener prompt) and a user message (starting turn)',
      };
    }

    const metadata = context?.test?.metadata || {};
    const topic = metadata.topic || '';
    const ideaArc = metadata.idea_arc || [];
    const arcLines = (Array.isArray(ideaArc) ? ideaArc : [ideaArc])
      .filter(Boolean)
      .map((b) => `- ${b}`)
      .join('\n');
    const simulatorSystem = `${this._loadSimulatorSystem()}

TOPIC: ${topic}

IDEA-DEVELOPMENT ARC (stages to move through as you develop the idea):
${arcLines}`;

    // Transcript is kept in listener's POV: role=user means thinker,
    // role=assistant means listener. When we call the simulator, we flip
    // roles so the simulator sees itself as the assistant.
    //
    // Every thinker turn passes through the (opt-in) disfluency layer as it
    // enters the transcript — the starting turn too, so a disfluent cell never
    // shows the listener a single line of clean prose. The transcript is the
    // one source for both the listener's messages and the judges' text, so
    // transforming here guarantees the judges score exactly what the listener
    // saw. (The simulator also sees its own past turns disfluent — harmless,
    // and it keeps one transcript instead of two diverging copies.)
    let thinkerTurnIndex = 0;
    const transcript = [
      { role: 'user', content: this._disfluent(startingTurn, thinkerTurnIndex++) },
    ];
    // Index of the thinker turn that ends the dictation — the last one, since
    // the last simulator call is given the LANDING directive. Starts at the
    // opening turn so a maxTurns=1 run (no simulator calls at all) still has a
    // defined landing rather than an unanchored transcript.
    let landingIndex = 0;
    const simulatorCalls = Math.max(this.maxTurns - 1, 0);
    const usage = { total: 0, prompt: 0, completion: 0, numRequests: 0 };
    let cost = 0;
    // How many LISTENER turns actually hit the target model. For the base
    // provider this equals the listener-turn count; the reduced-role subclass
    // answers light turns from its gate, so this drops below it — the headline
    // signal for "the model stays out of most turns".
    let modelCalls = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const listenerTurn = await this._listenerTurn({
        listenerSystem,
        transcript,
        context,
        turn,
      });
      if (listenerTurn.error) {
        return { error: listenerTurn.error };
      }
      transcript.push({ role: 'assistant', content: listenerTurn.text });
      accumulateUsage(usage, listenerTurn.tokenUsage);
      cost += listenerTurn.cost || 0;
      if (listenerTurn.modelCalled !== false) modelCalls += 1;

      if (turn === this.maxTurns - 1) break;

      // Flip roles so the simulator sees itself as the assistant, then
      // sanitize for the provider (drop silent turns, keep roles alternating).
      // The phase directive rides on the system prompt for this call only — the
      // last call is the one told to land the idea.
      const simulatorMessages = toProviderMessages(
        `${simulatorSystem}\n\n${phaseDirective(turn, simulatorCalls)}`,
        transcript.map((m) => ({
          role: m.role === 'user' ? 'assistant' : 'user',
          content: m.content,
        })),
      );
      const simResp = await this._simulator.callApi(
        JSON.stringify(simulatorMessages),
        context,
      );
      if (simResp.error) {
        return { error: `simulator turn ${turn + 1}: ${simResp.error}` };
      }
      const simText = this._disfluent(
        String(simResp.output ?? '').trim(),
        thinkerTurnIndex++,
      );
      transcript.push({ role: 'user', content: simText });
      landingIndex = transcript.length - 1;
      accumulateUsage(usage, simResp.tokenUsage);
      cost += simResp.cost || 0;
    }

    const resultMetadata = {
      turns: transcript.length,
      listenerTurns: transcript.filter((m) => m.role === 'assistant').length,
      thinkerTurns: transcript.filter((m) => m.role === 'user').length,
      listenerModelCalls: modelCalls,
    };
    // Surface the noise parameters only when the layer is on — a transcript
    // must always be traceable back to its seed, and an untouched cell must
    // keep its exact pre-disfluency metadata shape.
    if (this.disfluency) {
      resultMetadata.disfluency = { seed: this.disfluency.seed, level: this.disfluency.level };
    }

    return {
      output: formatTranscript(transcript, landingIndex),
      tokenUsage: usage,
      cost,
      metadata: resultMetadata,
    };
  }

  // Apply the opt-in disfluency layer to ONE thinker turn. Identity when the
  // option is absent (the returned string is the exact input, so untouched
  // cells stay byte-for-byte identical). The per-turn seed offset decorrelates
  // noise across turns while keeping the whole run a pure function of the
  // configured seed.
  _disfluent(text, thinkerTurnIndex) {
    if (!this.disfluency) return text;
    return applyDisfluency(text, {
      seed: this.disfluency.seed + thinkerTurnIndex,
      level: this.disfluency.level,
    });
  }

  // Seam: produce ONE listener turn from the running transcript.
  //
  // Base behaviour: always call the target model with the listener system
  // prompt + full transcript. Subclasses override this to short-circuit light
  // turns (see providers/reduced-role.js) while the surrounding simulator
  // loop, usage/cost accounting, and transcript formatting stay identical.
  //
  // Args:  { listenerSystem, transcript, context, turn }
  //          transcript is in listener POV (user = thinker, assistant =
  //          listener); the latest thinker turn is the last role:'user' entry.
  // Returns: { text, tokenUsage, cost, modelCalled } on success;
  //          { error } on failure (aborts the run).
  async _listenerTurn({ listenerSystem, transcript, context, turn }) {
    const listenerMessages = toProviderMessages(listenerSystem, transcript);
    const resp = await this._listener.callApi(
      JSON.stringify(listenerMessages),
      context,
    );
    if (resp.error) {
      return { error: `listener turn ${turn + 1}: ${resp.error}` };
    }
    return {
      text: String(resp.output ?? '').trim(),
      tokenUsage: resp.tokenUsage,
      cost: resp.cost || 0,
      modelCalled: true,
    };
  }
}

// Build a provider-safe chat array from listener-POV turns. An idea-dictation
// listener stays silent while the thinker dictates, which surfaces as an empty
// turn; the Anthropic Messages API rejects BOTH empty content blocks and
// non-alternating roles, so a silent turn would abort the run. Drop empty
// (silent) turns and merge consecutive same-role turns so what we SEND always
// alternates and is non-empty. The raw transcript keeps the silences intact —
// only the model-facing copy is sanitized.
function toProviderMessages(systemContent, turns) {
  const msgs = [{ role: 'system', content: systemContent }];
  for (const t of turns) {
    const content = String(t.content ?? '').trim();
    if (!content) continue; // silence — nothing to send
    const last = msgs[msgs.length - 1];
    if (last.role === t.role) {
      last.content += `\n\n${content}`; // keep roles strictly alternating
    } else {
      msgs.push({ role: t.role, content });
    }
  }
  return msgs;
}

// Format a listener-POV transcript into the "THINKER: …\n\nLISTENER: …" text
// the judges score, with LANDING_MARKER after the turn at `landingIndex`.
//
// Silent listener turns (idea-dictation: the listener stays quiet while the
// thinker dictates) carry no text — omit them so the transcript reads as the
// thinker dictating with the listener speaking only when it pulls a thread.
// The judges score this text; restraint reads the sparse listener presence
// as silence, probing-depth scores the thread-pull(s) that remain.
//
// Exported so providers/replay.js emits the EXACT same transcript shape from a
// fixture-driven loop — the judges must be unable to tell a replay cell from a
// simulator cell by format alone.
function formatTranscript(transcript, landingIndex) {
  const lines = [];
  transcript.forEach((m, i) => {
    const content = String(m.content ?? '').trim();
    if (content) {
      lines.push(`${m.role === 'user' ? 'THINKER' : 'LISTENER'}: ${content}`);
    }
    // The landing marker is positional, so it is emitted even when the
    // landing turn itself came back empty — the judges need the boundary,
    // and its position is what carries the meaning.
    if (i === landingIndex) lines.push(LANDING_MARKER);
  });
  return lines.join('\n\n');
}

function accumulateUsage(total, u) {
  if (!u) return;
  total.total += u.total || 0;
  total.prompt += u.prompt || 0;
  total.completion += u.completion || 0;
  total.numRequests += u.numRequests || 1;
}

module.exports = MultiTurnProvider;
// Exported so judges/tests can pin the exact marker string rather than
// re-typing it (a silently drifted copy would un-anchor the restraint rubric
// and put the column straight back to un-measurable).
module.exports.LANDING_MARKER = LANDING_MARKER;
module.exports.phaseDirective = phaseDirective;
// Shared with providers/replay.js so a fixture-replayed cell and a simulator
// cell produce byte-identical transcript formatting and usage accounting.
module.exports.formatTranscript = formatTranscript;
module.exports.accumulateUsage = accumulateUsage;
