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
// "THINKER: ...\n\nLISTENER: ...\n\n...". All three judges score against
// this transcript.
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
//
// Subclassing: the per-turn listener call is isolated in the _listenerTurn()
// seam so a subclass (see providers/reduced-role.js) can answer light turns
// from a rules gate without a model call, while reusing the whole simulator
// loop, usage/cost accounting, and transcript formatting unchanged.

const fs = require('fs');
const path = require('path');

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
    const transcript = [{ role: 'user', content: startingTurn }];
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

      const simulatorMessages = [
        { role: 'system', content: simulatorSystem },
        ...transcript.map((m) => ({
          role: m.role === 'user' ? 'assistant' : 'user',
          content: m.content,
        })),
      ];
      const simResp = await this._simulator.callApi(
        JSON.stringify(simulatorMessages),
        context,
      );
      if (simResp.error) {
        return { error: `simulator turn ${turn + 1}: ${simResp.error}` };
      }
      const simText = String(simResp.output ?? '').trim();
      transcript.push({ role: 'user', content: simText });
      accumulateUsage(usage, simResp.tokenUsage);
      cost += simResp.cost || 0;
    }

    const formatted = transcript
      .map((m) => `${m.role === 'user' ? 'THINKER' : 'LISTENER'}: ${m.content}`)
      .join('\n\n');

    return {
      output: formatted,
      tokenUsage: usage,
      cost,
      metadata: {
        turns: transcript.length,
        listenerTurns: transcript.filter((m) => m.role === 'assistant').length,
        thinkerTurns: transcript.filter((m) => m.role === 'user').length,
        listenerModelCalls: modelCalls,
      },
    };
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
    const listenerMessages = [
      { role: 'system', content: listenerSystem },
      ...transcript,
    ];
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

function accumulateUsage(total, u) {
  if (!u) return;
  total.total += u.total || 0;
  total.prompt += u.prompt || 0;
  total.completion += u.completion || 0;
  total.numRequests += u.numRequests || 1;
}

module.exports = MultiTurnProvider;
