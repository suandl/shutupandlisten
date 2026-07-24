// The corpus the blind-first-evaluation race (su-lou.10.8) is measured over —
// representative thinking-out-loud pauses, each labelled with what the gate sees
// (`textSoFar`) and what smart-turn would truly say for it (`trueVerdict`).
//
// This is a MECHANISM-DEMONSTRATION corpus, hand-authored in the spirit of the
// scenario-6 labeled vectors (spec/turn-vectors/labeled/tol-*): the structural
// finding — a floor below the EOU cost answers its first evaluation blind — holds
// for ANY corpus; these pauses put concrete transcripts behind the commit/false-cutoff
// counts. It deliberately spans the cases the gate routes differently once the EOU
// veto is bypassed (completionProb bridged to 1):
//
//   - FINISHED thoughts (trueVerdict 'complete'): committing to speak is CORRECT, but at
//     a sub-cost floor it still commits BLIND, before the verdict could confirm it.
//   - MID-THOUGHT thoughts (trueVerdict 'incomplete') whose words-so-far read as a
//     finished clause with no trailing-off punctuation: rule 2 (the veto) is the ONLY
//     thing that would hold them, and it is bypassed → FALSE CUTOFF (the B1 harm).
//   - MID-THOUGHT thoughts that visibly trail off (…, — ,): the gate's rule 3 catches
//     these on the WORDS, independent of the veto, so the race does NOT fire — the
//     honest other side of the finding (the gate is not wholly defenceless, but only
//     when the transcript itself shows the thought is unfinished).

import type { RacePause } from './race-measurement.ts';

export const RACE_CORPUS: readonly RacePause[] = [
  // ── Finished thoughts — a blind commit here lands on the right answer ──
  {
    name: 'finished-reflection',
    description: 'A substantive, cleanly-finished thought (the U6 demo turn 1). → reflection; correct, but committed blind at a sub-cost floor.',
    textSoFar: "I keep circling the same migration plan and I can't tell if the incremental path is actually safer or just slower",
    trueVerdict: 'complete',
    speechMs: 3200,
  },
  {
    name: 'finished-aside',
    description: 'A short, finished aside. → acknowledge (rules-only backchannel); a correct blind commit.',
    textSoFar: 'yeah, that makes sense',
    trueVerdict: 'complete',
    speechMs: 1200,
  },
  {
    name: 'finished-question',
    description: 'A direct question from the thinker. → question; correct, blind.',
    textSoFar: "do you think I'm overcomplicating this?",
    trueVerdict: 'complete',
    speechMs: 2000,
  },
  {
    name: 'finished-decision',
    description: 'A substantive finished thought that reads as a resolution. → reflection; correct, blind.',
    textSoFar: 'okay I think the real decision is just whether we can tolerate a day of read-only mode during the cutover',
    trueVerdict: 'complete',
    speechMs: 3000,
  },

  // ── Mid-thought, no trailing-off cue — the veto is the ONLY backstop, and it is bypassed ──
  {
    name: 'midthought-substantive',
    description: "B1 case: substantive words that read as a complete clause, but the thinker is mid-thought (pauses, then continues '…because the batching adds a failure mode'). No trailing punctuation ⇒ rule 3 misses it ⇒ FALSE CUTOFF.",
    textSoFar: 'the part I keep getting stuck on is whether we batch the writes or just eat the extra round trips',
    trueVerdict: 'incomplete',
    speechMs: 2800,
  },
  {
    name: 'midthought-dangling',
    description: "B1 case: the words obviously lead somewhere ('…on Friday is') but end on a bare word, not a discourse marker, so rule 3 cannot catch it ⇒ FALSE CUTOFF.",
    textSoFar: "so if I'm honest the thing that actually worries me about shipping this on Friday is",
    trueVerdict: 'incomplete',
    speechMs: 2600,
  },

  // ── Mid-thought that visibly trails off — rule 3 holds silence on the WORDS, no veto needed ──
  {
    name: 'midthought-trailing-conjunction',
    description: 'Mid-thought ending on an em dash. The gate rule-3 trailing-off cue holds silence on the words alone — the race does NOT fire even though the veto is bypassed.',
    textSoFar: 'I was going to say we should just use the queue, but—',
    trueVerdict: 'incomplete',
    speechMs: 2400,
  },
  {
    name: 'midthought-ellipsis',
    description: 'Mid-thought ending on an ellipsis. Rule 3 holds it on the words; race does not fire.',
    textSoFar: 'and then the other thing I wanted to get to is…',
    trueVerdict: 'incomplete',
    speechMs: 2200,
  },
];
