# CONCEPTS

Shared vocabulary for shutupandlisten. These terms carry a specific local
meaning — use them as written, and map synonyms back to them.

## Product

- **shutupandlisten** — A voice-mode "quiet thought companion": an AI that holds
  back while a person thinks out loud, biasing toward silence and minimal
  response rather than summary, coaching, or analysis. Today it is a system
  prompt; the goal is to deliver it as a standalone product others can use.

- **quiet thought companion** — The product's role: help the speaker keep
  thinking — not solve, explain, summarize, coach, or conclude.

- **response hierarchy** — The listener's ordered default behavior: silence →
  minimal acknowledgment → short momentum-preserving reflection → one brief
  follow-up question. Escalate slowly; most pauses should not become questions.

## Eval harness roles

- **listener** — The system under test: the model + prompt producing the
  companion side of a conversation. Scored by the judges.

- **thinker** — The user-simulator: a person thinking out loud, not asking for
  advice. Drives the user side of each scenario, pinned to one model so it is not
  a confound when comparing listeners.

- **judges** — Four rubric scorers run against a full transcript:
  - **restraint** — does the listener stay out of the way *while the idea is
    being dictated*, or take over with summary / coaching / paraphrase? Scored
    against the **landing** — the point where the thinker finishes laying the
    idea out — because one thread-pull after it is the job, and the same
    sentence before it is an interruption.
  - **variety** — across the conversation, do the listener's questions vary in
    stem and target? Returns **N/A** below two questions: variety is undefined
    on a single sample, and scoring it there flatters a listener that asks
    nothing.
  - **probing-depth** — does the listener engage the *specific* things the
    thinker said, or pivot to generic prompts?
  - **no-summarize** — does any turn reflect the thinker's own thought back at
    them, in any wording? Judged as a semantic move, not a phrase list.

## Delivery architecture

- **pipeline** — The favored delivery architecture: endpointing → speech-to-text
  → a text-only LLM (the listener decision) → text-to-speech. Components are
  separable and controllable, and the text-LLM stage is directly scoreable by the
  judges.

- **voice-native** — The alternative: a single end-to-end realtime voice model
  that listens and replies, with turn-taking baked in and billing per
  audio-minute.

- **endpointing** (silence-detection) — Deciding when the speaker has finished a
  thought versus merely paused to think. The product-defining component: the
  companion must not mistake a thinking-pause for a turn.

- **reduced role** — Running the pipeline so the endpointing + rules layer handles
  silence and acknowledgments, and the text-LLM is invoked only for substantive
  replies — lowering the quality bar a small, eventually on-device, model must
  clear.

- **patience window** — The load-bearing turn-detection tunable: how long silence
  must persist before a pause is treated as a finished thought rather than active
  thinking. Biases the companion toward waiting; most pauses never cross it.

## Delivery economics

- **the baseline** — The operator's ChatGPT voice + the instructions: the fixed
  reference every candidate is measured against. It already works for daily use,
  so the question is "match or beat it," not "does this work."

- **usefulness bar** — The on-device acceptance reference that replaces a scored
  comparison to the baseline: a short qualitative rubric of what would make the
  operator reach for the on-device flow, flaws and all. The question becomes
  "useful enough?", not "better than the baseline?".

- **off-host** — A delivery whose marginal compute cost the operator does not pay:
  the user's own device runs the models (on-device). The economic endgame,
  because per-minute cloud cost is hostile to free, adoption-first delivery.

- **the two axes** — The evaluation's coupled dimensions: quality (does the
  pipeline hold restraint + naturalness vs the baseline) and cost-to-deliver
  (per-session and per-user economics of each delivery option).

## Testing & gates

See `docs/testing-strategy.md` for the tiers these terms belong to.

- **works-check** — The command that proves the shipped pipeline stages load
  their **real backend** and produce output on a fixture, headless against a
  production-shaped build (`npm run works-check`). Liveness, not accuracy: it
  answers "does this run?", never "is this good?".

- **works-gate** — The works-check used as enforcement: the refinery running it
  before it lands a web deliverable. The check and the gate are separate — the
  check ships and runs standalone whether or not the gate is wired.

- **real backend** — The live implementation of a stage, as opposed to a
  **labelled degrade**: the stub or fallback a stage announces itself as after
  failing to load (`stub`, `sim`, `heuristic`, passthrough). Each stage's real
  backend is declared explicitly, so a stage whose intended floor *is* a
  fallback is not counted as a regression.

- **real regression** vs **infra flake** — The two failure verdicts. A real
  regression is a stage that loaded but reports a degrade, or produced nothing;
  it blocks a land and names the stage. An infra flake is provisioning, launch,
  WASM-init, or a timeout; it does not block, but is surfaced. "Not
  provisioned" and "broken" must never be confusable.
