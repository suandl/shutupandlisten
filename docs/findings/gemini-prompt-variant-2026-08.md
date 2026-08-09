---
title: "Gemini prompt variant + provider: the prompt measures best of the three; the model rung is unmeasured for want of a key"
type: findings
status: measured — prompt axis, 2026-08-09; Gemini MODEL cells blocked on a missing credential
unit: U5 (listener) · U2 (harness scoring)
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
requirements: [R1, R2]
bead: su-5ky
date: 2026-08-09
---

# Gemini prompt variant + provider (2026-08-09)

su-5ky adds a third listener prompt (`prompts/gemini.md`) and a third cloud
provider (`google:gemini-2.5-flash`) to the promptfoo matrix. This records what
was measured, what was deliberately not shipped, and the one thing that is
blocked.

**Four things, headline first:**

1. **`gemini.md` is the best of the three prompts on this run** — mean-of-four
   **3.563**, against v0 `claude.md` 3.375 and shipped `chatgpt.md` 3.125. It
   wins the **B3 dealbreaker outright (4.625**, vs 4.125 and 3.375), holds v0's
   probing to within a rounding cell (4.875 vs 5.000), and picks up +0.50 of
   variety over v0.
2. **The Gemini MODEL rung was never scored.** No Google credential exists in
   the `shutupandlisten` vault. The provider is wired and resolves; it fails at
   exactly one point, the key. Every number here is the *prompt* axis measured
   on the two credentialed providers.
3. **The one tuning round was run, measured, and REVERTED.** It targeted the
   single real defect (a banned phrase appearing in output) and made it worse —
   banned-phrase hits 1 → 2, probing −0.875. This is an independent replication
   of su-lou.16 §5: adding prohibition text to this prompt family does not
   reduce the banned behaviour and does cost probing depth.
4. **"Models never hold silence" replicates exactly.** Across 40 listener turns
   in the shipped run and 40 more in the tuning round, **not one turn was
   silent** — matching su-lou.16 finding #3 on a different prompt.

---

## 1. Substrate

| Fact | Value |
|---|---|
| promptfoo | 0.121.12 |
| `validate` | `Configuration is valid.` (exit 0) |
| unit tests | 50 tests — **48 pass / 0 fail / 2 skipped** (was 47/45/2; +3 from the widened banned-phrase sync) |
| shipped run | eval id `eval-GEO-2026-08-09T21:22:58` — **24 cells, 0 errors**, 2m21s, 527,842 tokens |
| tuning run | eval id `eval-66B-2026-08-09T21:28:28` — 8 cells, 0 errors, 1m16s, 201,597 tokens |
| matrix run | 3 prompts × **2 credentialed** providers × 4 scenarios × 4 judges |
| simulator | pinned to `openai:gpt-4o` in every cell — the thinker stays a constant |
| base | `main` @ `56d5927`, branch `polecat/su-5ky` |

Keys resolved at use-time through 1Password (`scripts/eval-keys.sh`), `--no-cache`
on both runs. The same `better-sqlite3` host snag su-lou.16 §1 documented recurred
and was fixed the same way (rebuild that one binding with npm's bundled
`node-gyp`); it is a host npm-policy artifact, not a repo defect, and nothing was
changed to work around it.

**Why 24 cells and not 36.** The full expanded matrix is 3 × 3 × 4 = 36. The 12
`google-gemini-2.5-flash` cells cannot run (§4), so the credentialed half is 24.

---

## 2. The prompt axis — the headline table

Mean of the 1–5 scores, n = 8 cells per prompt, computed by the repo's own
`.github/scripts/summarize-eval.js`.

| Prompt | probing | restraint | **no-summ (B3)** | variety | mean-of-4 |
|---|---:|---:|---:|---:|---:|
| `chatgpt` — hardened (ships) | 3.625 | 1.875 | 3.375 | **3.625** | 3.125 |
| `claude` — v0 baseline | **5.000** | **2.000** | 4.125 | 2.375 | 3.375 |
| **`gemini` — v0 + spoken hygiene** | 4.875 | 1.875 | **4.625** | 2.875 | **3.563** |

Read: the new variant keeps v0's probing discipline (−0.125, one cell scoring 4
instead of 5), takes the B3 dealbreaker to the best figure any prompt has posted
here (+0.50 over v0, +1.25 over the shipped prompt), and recovers half of v0's
variety deficit. Restraint is −0.125 — one cell, and it fails on every prompt
anyway (§5).

Overall by judge, all 24 cells: probing **4.50** (21/24), restraint **1.92**
(1/24), no-summarize **4.04** (18/24), variety **2.96** (21/24).

### 2a. By provider (n = 12)

| Provider | probing | restraint | B3 | variety | mean-of-4 |
|---|---:|---:|---:|---:|---:|
| `openai-gpt-4o` | 4.333 | 2.000 | **4.417** | 2.417 | 3.292 |
| `anthropic-claude-haiku-4-5` | **4.667** | 1.833 | 3.667 | **3.500** | 3.417 |

The B3 model axis su-lou.16 found (gpt-4o above haiku) reproduces: 4.417 vs
3.667, a 0.75 spread against a 1.25 prompt spread. On this run the prompt effect
is the larger of the two — the opposite of su-lou.16's ordering, and the reason
is that `gemini.md` widened the prompt axis at the top. Both runs agree on the
substantive point: **both axes are real, and neither alone accounts for B3.**

### 2b. By prompt × provider (n = 4)

| Prompt × provider | mean-of-4 |
|---|---:|
| **gemini × gpt-4o** | **3.625** |
| claude × haiku | 3.563 |
| gemini × haiku | 3.500 |
| chatgpt × haiku | 3.188 |
| claude × gpt-4o | 3.188 |
| chatgpt × gpt-4o | 3.063 |

`gemini × gpt-4o` is the strongest configuration measured, and it posts a clean
**B3 5.000** across all four scenarios.

---

## 3. The baselines reproduce — why the new column is trustworthy

The two pre-existing prompts were re-run in the *same pass* as the new one, so
they double as a replication of su-lou.16 (2026-08-05, a different day, a fresh
`--no-cache` run):

| Judge | claude: su-lou.16 → now | chatgpt: su-lou.16 → now |
|---|---|---|
| probing | 5.00 → **5.000** | 3.50 → **3.625** |
| restraint | 2.00 → **2.000** | 1.88 → **1.875** |
| no-summarize (B3) | 4.00 → **4.125** | 3.38 → **3.375** |
| variety | 2.38 → **2.375** | 3.63 → **3.625** |

Maximum deviation across eight columns: **0.125** — a single cell. For a harness
whose own caveat is "one pass, non-deterministic," that is far better stability
than the prior document claimed for itself, and it means the `gemini` column is
measured against baselines that did not drift under it.

It also sets the noise floor for reading §2: on an 8-cell mean, one cell moving
one point is ±0.125. Differences at that scale (gemini's −0.125 probing, −0.125
restraint) are **not** distinguishable from noise. The +0.50 B3 gain and the
+1.25 probing gap over `chatgpt.md` are well clear of it.

---

## 4. The blocker: no Gemini credential

`promptfoo eval --filter-providers google` fails in 2 seconds, zero tokens:

```
"providerLabel": "google-gemini-2.5-flash",
"error": "Google API key is not set. Set the GOOGLE_API_KEY or GEMINI_API_KEY
          environment variable or add `apiKey` to the provider config."
```

That error is the *good* outcome: promptfoo resolved `google:gemini-2.5-flash`,
loaded the provider through `multi-turn.js`, and got as far as the key check —
so the wiring is complete and only the secret is missing. The
`shutupandlisten` 1Password vault holds exactly two items, `openai` and
`anthropic`.

**Why `.env.op` ships the key line commented out.** `op run` resolves *every*
reference in the env-file before exec'ing the child, and aborts the whole
invocation if any one of them misses. Verified against this vault:

```
[ERROR] could not resolve item UUID for item google: could not find item
        google in vault lvrubwybt6z2cqhgjjmioy77ie
```

— and the child never ran. A live `GOOGLE_API_KEY=op://…` line would therefore
have taken the OpenAI and Anthropic cells, `npm run eval`, `eval:smoke`,
`test:judges` and the CI job down with it, for a provider nobody had a key for.
The same reasoning keeps `google-gemini-2.5-flash` out of CI's `EVAL_PROVIDERS`:
an uncredentialed rung there can only error, never score.

**To unblock** (three steps, `promptfoo/README.md` → "Adding the Gemini key"):
create a `google` item with an `api-key` field in the `shutupandlisten` vault;
uncomment the line in `promptfoo/.env.op`; add the label to `EVAL_PROVIDERS`.
Then re-run the full 36-cell matrix — the 12 Gemini-model cells are the only
ones this document cannot speak to.

---

## 5. The tuning round: run, measured, reverted

The acceptance bar allowed one round of Gemini-specific tuning. There was one
concrete defect to aim it at: in the shipped run, the `gemini × haiku ×
essay-thesis` cell scored restraint **1**, and the judge's reason named the
cause — the listener opened turn 2 with *"You're describing…"*, a phrase
`gemini.md`'s own avoid-list bans, and any banned phrase caps restraint at 2.

The round added one bullet to the thread-pull section: open with the question
itself, no lead-in clause that names what the thinker is doing. It prohibits a
move rather than permitting one, so it should have been safe by su-lou.16's
mechanism. It was not:

| | probing | restraint | B3 | variety | mean-of-4 | banned-phrase hits |
|---|---:|---:|---:|---:|---:|---:|
| shipped (no tuning) | **4.875** | 1.875 | **4.625** | 2.875 | **3.563** | **1** |
| tuned | 4.000 | 2.000 | 4.500 | 3.143 | 3.406 | 2 |

It **failed on its own terms** — the banned phrase it targeted appeared *more*
often, not less (1 hit → 2, both `You're describing…` on haiku) — and it cost
0.875 of probing. The lone restraint gain is an artifact: it comes from one cell
(`gemini × haiku × story-premise`) that collapsed into near-silence, scoring
restraint 4 while posting probing **1** and too few questions to score variety
at all. That is not restraint; it is the listener failing to do the job, and the
restraint column rewarding it.

**Reverted.** `prompts/gemini.md` as committed is byte-identical to the version
that produced the 3.563 row. The finding stands on its own: this is a second,
independent replication of su-lou.16 §5 — adding prohibition text to this prompt
family does not reduce the prohibited behaviour, and it reliably costs probing
depth. The next person to reach for "just tell it harder" should read this row
first.

---

## 6. What the prompt variant actually changes

`gemini.md` is a **+15/−1-line fork of `claude.md`**, chosen because the
2026-08-05 re-score (§3b there) put v0 ahead of the shipped prompt on both
judges the bead named as the fork criterion — probing 5.00 vs 3.50 and restraint
2.00 vs 1.88 — and on B3 as well.

Every added line is output **format**; none is response **selection**. That
split is the design, and §5 above is the evidence for it:

- **Imported from `chatgpt.md`:** spoken-output hygiene — no markdown, no stage
  directions, no self-narration, finished sentences. `claude.md` has none of
  this, and every voice surface needs it. It cannot move the judges hardening
  hurt, because it governs how a reply is written, not whether to make one.
- **Deliberately NOT imported:** the response *hierarchy*. su-lou.16 §5 names its
  level-2 "minimal acknowledgment" and level-3 "short momentum-preserving
  reflection" rungs as the mechanism behind the shipped prompt's −1.50 probing
  and −0.62 B3. The B3 column in §2 is what leaving it out buys.
- **Gemini-specific additions:** a no-preamble rule (a turn announcing "I'll just
  listen" is an interruption with better manners), an explicit statement that an
  empty turn is a complete and valid answer, and a one-question-mark cap.

These last three are **hypotheses about Gemini that this run could not test** —
they were written for known Gemini habits (markdown by default, chatty
compliance-preamble, question-stacking) and have only been measured on gpt-4o and
haiku, where they did no harm and the file posted the best B3 of any prompt.
Whether they do the job on Gemini itself is exactly what §4 blocks.

---

## 7. What this does and does not establish

**Establishes.** On the credentialed cloud rung: `gemini.md` is the strongest of
the three prompts overall and on the B3 dealbreaker, at no measurable cost to
probing; the two existing prompt columns reproduce su-lou.16 to within 0.125;
the B3 model axis is real; a prohibition-style tuning round measurably backfired
and was reverted.

**Does not establish.**

- **Nothing about Gemini the model.** The 12 `google-gemini-2.5-flash` cells did
  not run (§4). The variant is named for the model it was written for, but it has
  only ever been scored on gpt-4o and haiku. Nothing here says how Gemini behaves.
- **Nothing about restraint.** It reads 1.92 with 1/24 passing and every prompt
  sits in the same failing band. Across 80 listener turns over both runs, zero
  were silent — su-lou.16's finding #3, replicated. This is a property of the
  turn-by-turn cadence and the models, not of the prompt axis, and no prompt in
  this matrix moves it.
- **Still a clean-text upper bound.** The thinker emits clean prose; live
  disfluent STT will read no better (the U2→U5 handoff gap).
- **One pass per configuration.** ±0.125 is one cell; read §2 accordingly (§3).

**Deliberately not done.** No prompt other than the new file was touched; no
judge, scenario, simulator, or provider config was altered; `claude.md` remains
the frozen v0 baseline; no lever was selected and nothing was promoted to ship.

## 8. Reproduce

```bash
cd promptfoo && npm ci
# host npm gates install scripts; rebuild the one native binding (su-lou.16 §6)
( cd node_modules/better-sqlite3 && node "$NODE_GYP" rebuild --release )
npm run validate                       # Configuration is valid.
npm test                               # 50 tests: 48 pass / 0 fail / 2 skipped

# the 24 credentialed cells (eval-GEO-2026-08-09T21:22:58)
../scripts/eval-keys.sh npx promptfoo eval \
    --filter-providers '^(openai|anthropic)-' \
    --no-cache --no-table --output <results.json>

node ../.github/scripts/summarize-eval.js <results.json>
```

Once the Gemini key exists, drop `--filter-providers` for the full 36-cell matrix.
