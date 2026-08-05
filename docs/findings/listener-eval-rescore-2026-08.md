---
title: "Listener-eval re-score on the repaired harness: B3/B4 on the frontier half (2 prompts × 2 frontier models × 4 scenarios × 4 judges)"
type: findings
status: measured — frontier rung, 2026-08-05; no lever selected (report-only)
unit: U8 (decision recommendation) · U5 (listener) · U2 (harness scoring)
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
requirements: [R1, R2]
bead: su-lou.16
date: 2026-08-05
---

# Listener-eval re-score, frontier half (2026-08-05)

The 16-cell frontier score table that su-lou's U7/U8 bearing rested on was
produced **before** two harness fixes landed (su-lou.12 repaired the restraint
judge and closed the variety loophole; su-lou.13 hardened `chatgpt.md`), and
`promptfoo/` had had no commit since. This is the re-run on the repaired
harness. **It picks no lever, changes no prompt, and builds nothing.** It is the
frontier half only — the `openai:gpt-4o` / `anthropic:claude-haiku-4-5` surface
the iOS Analyst inherits under the 2026-08-05 pivot — and deliberately excludes
the on-device (ollama) family (§1, §7).

**Four things the re-score establishes, headline first:**

1. **B3 ("never summarizes back") is *not* cleanly prompt-bound.** This run shows
   a **model** effect (gpt-4o 4.13 vs haiku-4-5 3.25) that is *larger* than the
   prompt effect (v0 4.00 vs hardened 3.38). B3 is imperfect on every
   configuration — the dealbreaker still fires in 6 of 16 cells (score ≤ 3) — and
   the stronger general model scored *better* on it, not worse.
2. **The shipped hardened prompt (`chatgpt.md`) is *worse* than the untouched v0
   baseline (`claude.md`) on B3 (3.38 vs 4.00) and probing (3.50 vs 5.00),** and
   better only on variety (3.63 vs 2.38). su-lou.11/.13's hardening traded
   probing + no-summarize away for question variety.
3. **B4 "rare" is real and now measurable — and uniformly failing.** With the
   restraint judge repaired, restraint reads **1.94 mean, 0/16**, and it carries
   signal now: across ~80 listener turns the models **never once stayed silent**,
   asking a mid-dictation question every turn (interview cadence). The harness
   *does* support silence; the models simply don't use it.
4. **B4 "brief" is *not* reproduced on the frontier surface with the shipped
   prompt.** The hardened prompt's brevity cap works — its replies run 11–27
   words/turn — so the operator's "verbose, hit the token cap" observation does
   not appear here; it belongs to a different substrate.

Per su-lou's own report-only instruction, this document selects, tunes, and
recommends **nothing**.

---

## 1. Substrate — read this before the numbers

**The harness was live and real.** Keys resolved at use-time through 1Password
(`op run --env-file promptfoo/.env.op`, via `scripts/eval-keys.sh` reading
`~/.config/gascity/op-sa-token`) — nothing landed on disk. Both frontier
providers answered: promptfoo reports **0 errors** across **144 requests** and
**334,546 tokens** (205,740 eval + 128,806 grading), duration 2m20s, eval id
`eval-tO2-2026-08-05T03:03:24`, run `--no-cache` (a genuinely fresh pass, no
cached responses).

| Fact | Value |
|---|---|
| promptfoo | 0.121.12 |
| `validate` | `Configuration is valid.` (exit 0) |
| unit tests | 47 tests — **45 pass / 0 fail / 2 skipped** (matches su-lou.13 exactly) |
| matrix | 2 prompts × 2 frontier providers × 4 scenarios × 4 judges = **16 cells** |
| simulator ("thinker") | pinned to `openai:gpt-4o` across **all** cells — the thinker is a constant; only the listener (prompt × model) varies |
| turns | `maxTurns=5` → 5 listener + 5 thinker turns/cell; landing marker after the final thinker turn |
| base | `main` @ `62774c9`, branch `polecat/su-lou.16` |

**The matrix axes.** Prompts: `claude.md` (**v0 baseline**, untouched) and
`chatgpt.md` (**hardened**, the prompt the web app ships). Providers:
`openai-gpt-4o`, `anthropic-claude-haiku-4-5`. Scenarios: `essay-thesis`,
`feature-idea`, `research-hunch`, `story-premise` — each a 5-turn dictation the
thinker lays out and lands. The frontier filter
`--filter-providers '^(openai|anthropic)-'` was verified to select exactly the
16 frontier cells (console: `Running 16 test cases`) and **no** ollama cells.

**One environment snag, recorded for the next runner — not a repo defect.** This
host's npm gates install scripts (`~/.npmrc: allow-scripts=…`), so `npm ci` left
`better-sqlite3`'s native binding **unbuilt** and promptfoo 0.121.12 died at
`Database migration failed: Could not locate the bindings file`. The fix is to
compile that one binding with npm's bundled `node-gyp` (command in §6); it is a
host/npm-policy artifact, not a fault in `promptfoo/`, so nothing in the repo was
changed to work around it. CI, which does not carry that `.npmrc`, is unaffected.

**The four judges (what each column means).**

- **probing-depth** (1–5) — does the post-landing thread-pull name a *specific*
  piece of the idea and push it further, vs. a generic or emotional pivot. This
  judge was **not** broken pre-fix, so it is the one clean old-vs-new comparison.
- **restraint** (1–5) — silent above the landing marker, at most one short
  thread-pull below it; a banned phrase caps at 2. This is the **B4 "rare"**
  column. It read 0/16 *by construction* before su-lou.12 (the simulator never
  ended dictation, so every listener turn was mid-dictation and unscoreable);
  now the dictation lands and the column carries signal.
- **no-summarize / B3** (1–5) — does any turn reflect, characterise, or narrate
  the thinker's own thought back, in *any* wording (semantic, not a phrase
  list). **B3 is the dealbreaker** on the usefulness bar.
- **variety** (1–5) — how much the listener's questions differ. Excluded (N/A)
  below two questions by `asserts/variety.js`; the old 3.63 came from the *old*
  rubric that scored zero-question transcripts a perfect 5 (loophole closed in
  su-lou.12).

---

## 2. The numbers — by judge, old alongside new

Column math is the repo's own `.github/scripts/summarize-eval.js` (mean of the
1–5 scores; pass-rate is each grader's own pass/fail boolean; N/A cells excluded
from both).

| Judge | OLD (pre-fix) | NEW — 2026-08-05 (repaired) | Read |
|---|---|---|---|
| **probing-depth** | 4.00 · 12/16 | **4.25 · 15/16** · 0 n/a | steady–slightly up; the clean comparison |
| **restraint (B4 "rare")** | 0/16 *(invalid — judge broken by construction)* | **1.94 · 0/16** · 0 n/a | now carries signal, and it is uniformly failing |
| **no-summarize (B3)** | *not recorded in any committed artifact* | **3.69 · 10/16** · 0 n/a | dealbreaker still fires in 6/16 |
| **variety** | 3.63 · 14/16 *(inflated — zero-question loophole)* | **3.00 · 14/16** · 0 n/a | drops once the loophole is closed |

> **The mean is the trustworthy signal; read the pass-rate with care.** promptfoo's
> `llm-rubric` derives each cell's pass/fail from the grader model, not from a
> fixed score threshold — which is why variety shows 14/16 "pass" even though
> three cells scored 1. Where mean and pass-rate disagree, this document leans on
> the mean.

Two structural notes that make the deltas legible:

- **restraint** was `0/16` both times, but the two zeros mean opposite things.
  The old zero was *unmeasurable* (no landing, every turn mid-dictation). The new
  zero is *measured*: the dictation lands, the judge works, and the listeners
  still fail — mean 1.94, every cell in the "repeated over-engagement above the
  marker" band.
- **variety** shows the loophole closing. The old 3.63/14-of-16 was propped up by
  zero-question cells scoring 5; this run every cell asked ≥ 2 questions (0 n/a),
  so the column is fully assessed and lands at 3.00.

---

## 3. Per-cell and per-axis tables

### 3a. All 16 cells (1–5 per judge)

| Prompt | Provider | Scenario | probing | restraint | no-summ (B3) | variety |
|---|---|---|---:|---:|---:|---:|
| claude (v0) | gpt-4o | essay-thesis | 5 | 2 | 2 | 1 |
| claude (v0) | gpt-4o | feature-idea | 5 | 2 | 5 | 1 |
| claude (v0) | gpt-4o | research-hunch | 5 | 2 | 5 | 3 |
| claude (v0) | gpt-4o | story-premise | 5 | 2 | 5 | 1 |
| claude (v0) | haiku-4-5 | essay-thesis | 5 | 2 | 4 | 4 |
| claude (v0) | haiku-4-5 | feature-idea | 5 | 2 | 5 | 3 |
| claude (v0) | haiku-4-5 | research-hunch | 5 | 2 | 3 | 3 |
| claude (v0) | haiku-4-5 | story-premise | 5 | 2 | 3 | 3 |
| chatgpt (hardened) | gpt-4o | essay-thesis | 3 | 2 | 3 | 3 |
| chatgpt (hardened) | gpt-4o | feature-idea | 3 | 2 | 5 | 3 |
| chatgpt (hardened) | gpt-4o | research-hunch | 4 | 2 | 4 | 3 |
| chatgpt (hardened) | gpt-4o | story-premise | 3 | 2 | 4 | 3 |
| chatgpt (hardened) | haiku-4-5 | essay-thesis | 5 | 1 | 3 | 4 |
| chatgpt (hardened) | haiku-4-5 | feature-idea | 5 | 2 | 3 | 5 |
| chatgpt (hardened) | haiku-4-5 | research-hunch | 1 | 2 | 2 | 5 |
| chatgpt (hardened) | haiku-4-5 | story-premise | 4 | 2 | 3 | 3 |

### 3b. By prompt (n = 8 each) — the hardened-vs-v0 axis

| Prompt | probing | restraint | no-summ (B3) | variety |
|---|---:|---:|---:|---:|
| **claude — v0 baseline** | **5.00** | 2.00 | **4.00** | 2.38 |
| **chatgpt — hardened (ships)** | 3.50 | 1.88 | 3.38 | **3.63** |

### 3c. By provider (n = 8 each) — the model axis

| Provider | probing | restraint | no-summ (B3) | variety |
|---|---:|---:|---:|---:|
| **openai-gpt-4o** | 4.13 | 2.00 | **4.13** | 2.25 |
| **anthropic-claude-haiku-4-5** | 4.38 | 1.88 | 3.25 | **3.75** |

### 3d. By prompt × provider (mean of all four judges, n = 4 each)

| Prompt × provider | mean |
|---|---:|
| claude (v0) × haiku-4-5 | 3.50 |
| claude (v0) × gpt-4o | 3.19 |
| chatgpt (hardened) × haiku-4-5 | 3.13 |
| chatgpt (hardened) × gpt-4o | 3.06 |

### 3e. Reply length per turn (the "brief" half of B4)

Words per listener turn, max and total across the 5-turn transcript:

| Prompt × provider | max turn (words) | total (words) |
|---|---:|---:|
| chatgpt (hardened) × gpt-4o | 11–15 | 45–66 |
| chatgpt (hardened) × haiku-4-5 | 13–27 | 40–87 |
| claude (v0) × gpt-4o | 26–34 | 114–151 |
| claude (v0) × haiku-4-5 | 36–53 | 151–192 |

---

## 4. The four questions — direct verdicts

### Q1 · B3 "never summarizes back" — is it prompt-bound, and did hardening move it?

**Verdict: B3 is *not* cleanly prompt-bound, and hardening moved the column the
wrong way.** New column: **3.69 mean, 10/16**.

- **A real model axis exists.** By provider, B3 is **gpt-4o 4.13 vs haiku-4-5
  3.25** — a 0.88 spread, *larger* than the 0.62 prompt spread. su-lou's standing
  conclusion ("B3 is prompt-bound, not model-bound; a bigger model should not be
  expected to fix it") is not supported by this run: the stronger general model
  scored **better** on B3, and the model effect was at least as large as the
  prompt effect. One noisy pass (n = 8/group) cannot overturn a qualitative
  conclusion, but it clearly complicates it — the "not model-bound" half no
  longer holds on this evidence.
- **Hardening hurt B3.** The v0 baseline scores **4.00**, the shipped hardened
  prompt **3.38**. The mechanism is visible in the transcripts: the hardened
  prompt's response *hierarchy* explicitly licenses "short momentum-preserving
  reflection" (level 3), which is exactly the playback B3 penalises — e.g.
  chatgpt×haiku replies like *"So the time isn't actually shorter, but the
  experience of it is"* and *"So the person doesn't know until they hear it coming
  back at them"* (both scored B3 = 2–3).
- **B3 is nowhere solved.** The best subgroup is claude×gpt-4o at 4.25, and even
  it contains a 2 (essay-thesis: *"repeated listener turns open by playing back
  the thinker's prior point before asking the next question"*). Across the matrix
  the dealbreaker fires (score ≤ 3) in **6 of 16 cells**.

### Q2 · B4 "rare and brief" — is it real?

**Verdict: the "rare" half is real and uniformly failing; the "brief" half is
not reproduced on this surface.**

- **"Rare" — clearly violated.** restraint is **1.94, 0/16**, and this is now a
  real measurement (the dictation lands; the judge works). Every cell sits in the
  "repeated over-engagement above the marker — interview cadence" band; one
  (chatgpt×haiku essay-thesis) hit the banned phrase *"You're describing…"* and
  was capped at 1. Critically, **the harness supports silence** — `multi-turn.js`
  keeps silent (empty) listener turns in the recorded transcript and only drops
  them from what it *sends* to the API — yet across ~80 listener turns in 16
  cells, **not one turn was silent.** Even the v0 prompt, which explicitly orders
  *"reply with nothing at all — an empty response"* during dictation, produced a
  question on every turn. The models will not hold silence in this turn-by-turn
  loop; that is the finding.
  - *Structural caveat:* the thinker lays the idea out across 5 discrete turns and
    the listener is polled after each, so 4 of the 5 listener turns fall **above**
    the marker. The harness gives the listener four chances to interject before
    the landing, and the frontier models take all four. This is a property of the
    turn-by-turn cadence as much as of the models; a live audio gate that owns
    silence-vs-speak (the U5 reduced-role idea) is not exercised here.
- **"Brief" — not reproduced here.** The operator's live observation was a
  *verbose* reply that hit the token cap. On this frontier surface the shipped
  hardened prompt is the **briefest** configuration (11–27 words/turn, §3e) — its
  "one sentence is the norm, two is the ceiling" cap works. The v0 baseline runs
  2–4× longer (up to 53 words/turn on haiku), but even that is nowhere near a
  token cap (~70 tokens). So the verbosity B4 worries about does **not** appear on
  the frontier models with the shipped prompt; it belongs to a different
  substrate (the browser/on-device listener or an unhardened prompt state), and
  this eval cannot corroborate it.

### Q3 · restraint — does it carry signal now, and what does it say?

**Verdict: yes, and it says restraint is uniformly poor and prompt/model-invariant.**
Pre-fix, the column was 0/16 by construction and told you nothing. Post-fix it is
1.94/0-of-16 and tightly clustered: 14 cells at 2, one at 1, one at 1 — no cell
above 2, on either prompt or either model. The listeners interject with questions
through the dictation and settle into an interview cadence in every configuration
(see the restraint reasons, uniformly "multiple mid-dictation questions above the
marker"). The column is now measuring something real; what it measures is a floor.

### Q4 · variety — how much of the old 3.63 survives?

**Verdict: it lands at 3.00 once the loophole is closed, and it is where the
hardened prompt earns its keep.** Every cell asked ≥ 2 questions this run (0 n/a),
so the whole column is assessed rather than propped up by zero-question 5s. The
prompt axis dominates: the v0 baseline is **2.38** (its single anchored-question
shape repeats — claude×gpt-4o produced *"How does the app…"* five times in one
cell → variety 1), while the hardened prompt is **3.63**. The model axis agrees
(haiku 3.75 > gpt-4o 2.25). Variety is the one dimension the hardening reliably
improved.

---

## 5. The hardened-vs-v0 prompt delta

The prompts started byte-identical at v0. su-lou.11 hardened `chatgpt.md` (voice
hygiene, a response hierarchy, a brevity cap, an expanded semantic anti-summarize
section) and su-lou.13 added +4 lines naming the anchored question as the
preferred move; `claude.md` stayed at v0. So the prompt axis is a clean
hardened-vs-baseline comparison, and this run reads it as a **trade, not an
improvement**:

| Judge | v0 (claude) | hardened (chatgpt) | Δ |
|---|---:|---:|---:|
| probing-depth | 5.00 | 3.50 | **−1.50** |
| restraint | 2.00 | 1.88 | −0.12 (both fail) |
| no-summarize (B3) | 4.00 | 3.38 | **−0.62** |
| variety | 2.38 | 3.63 | **+1.25** |

The hardened prompt buys question variety (+1.25) and reply brevity (§3e) at the
cost of probing depth (−1.50) and the B3 dealbreaker (−0.62). The likely
mechanism is the response *hierarchy*: by explicitly permitting minimal
acknowledgments (level 2) and "short momentum-preserving reflection" (level 3),
the hardened prompt sanctions exactly the mid-stream acknowledgment and playback
that restraint and B3 penalise, and it dilutes the single-anchored-question
discipline that gives the v0 prompt its 5.00 probing. This is the shipped prompt
scoring below the locked baseline on the two quality dimensions the bar cares
about most — recorded here as a fact, with no lever proposed.

---

## 6. Exact commands run

Host: 8-core Linux, `polecat/su-lou.16` at base `62774c9`.

```bash
cd promptfoo
npm ci                          # 714 packages; this host's npm gated 8 install scripts

# Environment snag (host npm allow-scripts gate), NOT a repo change:
# npm ci left better-sqlite3's native binding unbuilt → promptfoo dies at
# "Database migration failed: Could not locate the bindings file". Build that one
# binding with npm's bundled node-gyp (no shared-config mutation, no repo edit):
NODE_GYP=/home/zook/.nvm/versions/node/v24.18.0/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js
( cd node_modules/better-sqlite3 && node "$NODE_GYP" rebuild --release )

npm run validate                # Configuration is valid. (exit 0)
npm test                        # 47 tests: 45 pass / 0 fail / 2 skipped

# The frontier half only, fresh (no cache), keys injected at use-time via 1Password.
# Equivalent to `npm run eval -- …` (no ../.env.local present → the op path):
../scripts/eval-keys.sh npx promptfoo eval \
    --filter-providers '^(openai|anthropic)-' \
    --no-cache --no-table \
    --output <results.json>
# console: "Running 16 test cases (up to 4 at a time)…"  → filter verified: 16 cells, no ollama

# Canonical column math (mean / pass-rate / N/A handling):
node .github/scripts/summarize-eval.js <results.json>
```

The provider-filter regex matches promptfoo's provider **label**
(`openai-gpt-4o`, `anthropic-claude-haiku-4-5`, `ollama-*`), confirmed by the
smoke run — so `^(openai|anthropic)-` selects exactly the two frontier labels and
excludes every `ollama-*` cell. `--no-cache` forces a real pass (no reused
responses). `--no-table` suppresses only the terminal render; all scores come
from `<results.json>`.

---

## 7. What this does and does not establish

**Establishes.** On the frontier rung (gpt-4o, claude-haiku-4-5), with the
harness repaired: B3 has a real model axis and is worse on the shipped hardened
prompt than on the v0 baseline; restraint now carries signal and reads a uniform
floor (models never hold silence); variety settles at 3.00 with the loophole
closed and is the one dimension hardening improved; and the shipped prompt's
replies are brief, not verbose.

**Does not establish.**

- **The on-device (ollama) half was not run** — deliberately. It is not installed
  on this host (`command -v ollama` → nothing), and under the 2026-08-05 iOS
  pivot the shipped Analyst is frontier-backed, so the on-device class question is
  not what U8 now turns on. If that question is revived, the on-device half is a
  clean follow-up bead against this same harness; nothing here speaks to it.
- **This is a CLEAN-TEXT UPPER BOUND.** The thinker (`simulators/thinker.md`,
  pinned to gpt-4o) emits clean prose, so every score is an upper bound relative
  to live disfluent STT output — the known U2→U5 handoff gap. A live loop with
  real transcription will read no better than this and probably worse.
- **The operator's verbose-reply / token-cap observation is not corroborated
  here** (§4 Q2). This surface + the shipped prompt produce brief replies; the
  verbosity lives on a substrate this eval did not touch.
- **One pass, non-deterministic.** LLM calls run at the harness's default
  temperature; these are point estimates from a single 16-cell pass, not
  distributions. Pass/fail booleans are the grader's own (§2). Treat the means as
  directional, not precise to the second decimal.

**Deliberately not done.** No prompt was tuned, no model swapped, no judge
adjusted, no lever selected or recommended. Report-only, exactly like su-lou.14.1.

## 8. Reproduce

Every number above comes from the single measurement invocation in §6
(`promptfoo eval --filter-providers '^(openai|anthropic)-' --no-cache`,
eval id `eval-tO2-2026-08-05T03:03:24`), summarised by
`.github/scripts/summarize-eval.js`. The `npm ci` / `validate` / `test` steps and
the one-time `better-sqlite3` build are setup, not measurements.
