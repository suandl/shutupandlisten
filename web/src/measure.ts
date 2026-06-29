// CLI: print the scenario-6 metrics table from the labeled corpus.
//   npm run measure   (node --test never picks this up — no .test. in the name)
// Node-only (reads disk); keeps measurement.ts itself pure/browser-safe.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarize, formatTable, type LabeledVector } from './measurement.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '../../spec/turn-vectors/labeled');

const vectors = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabeledVector);

const summary = summarize(vectors);
console.log(formatTable(summary));
process.exit(summary.eouBeatsFloor ? 0 : 1);
