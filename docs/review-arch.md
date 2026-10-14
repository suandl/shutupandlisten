# Arch check — shutupandlisten architecture references

This repo has no `docs/architecture.md`. Its architecture lives in three places.
Read the ones the diff touches before judging it.

- **`CONCEPTS.md`** (repo root) — the shared vocabulary and the high-level model:
  the delivery architecture (the endpointing, speech-to-text, text-LLM, and
  text-to-speech pipeline; the patience window; the reduced-role split), the
  eval-harness roles (listener, thinker, judges), the delivery economics, and the
  testing-and-gates vocabulary. Start here. It links deeper references such as
  `docs/testing-strategy.md`; follow the ones the diff touches.
- **`spec/turn-state-machine.md`** — the runtime-agnostic contract for the
  turn-detection layer, the product-defining component. It is a pure reducer over
  `(state, event)`, and each build (the web runtime and the later native one)
  reimplements this document rather than sharing code.
- **`spec/turn-vectors/`** — the golden cross-runtime parity fixtures for that
  contract (`scenarios/`, `gate/`, `labeled/`). Every runtime must reproduce
  their expected output exactly, so they are where a turn-detection change shows
  it still holds the contract across runtimes.

An architecture change here is one that moves the pipeline model in `CONCEPTS.md`
or the turn-state contract in `spec/`. When a change moves either, its matching
update to these docs belongs in the same PR.
