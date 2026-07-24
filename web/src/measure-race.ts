// CLI: print the blind-first-evaluation race table (su-lou.10.8).
//   npm run measure:race   (node --test never picks this up — no .test. in the name)
//
// Deterministic — no browser, no dev server, no model. It drives the real reducers
// with the EOU verdict at its measured warmed cost and sweeps the su-lou.10.5 floor
// ladder; sibling to `npm run measure` (scenario 6) and the same shape. A MEASUREMENT,
// not a gate: it always exits 0 — closing the race is out of scope for su-lou.10.8, so
// a firing race is the reported finding, not a failure.

import { measureRace, formatRaceTable } from './race-measurement.ts';
import { RACE_CORPUS } from './race-corpus.ts';

console.log(formatRaceTable(measureRace(RACE_CORPUS)));
