// Banned-phrase sync — keyless, no model.
//
// U2 test scenario: the avoid-list in EVERY prompt under prompts/ and the
// score-capping list in judges/restraint.txt must stay identical, and there
// must be no further copy of the list in the reduced-role gate. The listener
// prompt tells the model what NOT to say; the judge caps the score when it
// says it anyway. If the two drift, the harness rewards or punishes phrases
// the prompt never mentioned. The gate emits only acks, so it must not carry
// its own copy.
//
// Every prompt is checked, not just the shipped one (su-5ky). The prompt axis
// crosses fully with the provider axis, so each prompt file is scored by the
// same restraint judge and each one can drift from it independently — a check
// pinned to a single file leaves the others free to fall out of sync, which is
// exactly what adding a third variant would have done.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTFOO_DIR = path.resolve(__dirname, '..');

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
const RESTRAINT_JUDGE = path.join(PROMPTFOO_DIR, 'judges', 'restraint.txt');
const REDUCED_ROLE = path.join(PROMPTFOO_DIR, 'providers', 'reduced-role.js');

// Every listener prompt in the matrix. Read from disk rather than hard-coded
// so a fourth variant is covered the moment it is added.
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

// Pull every double-quoted phrase out of a chunk of text. Used after each
// source's list region is isolated, so stray quotes elsewhere can't leak in.
function quotedPhrases(text) {
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

// A prompt file: the bullets under "Avoid phrases like:" to end of file.
function avoidListFromPrompt(file) {
  const content = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
  const idx = content.indexOf('Avoid phrases like:');
  assert.notEqual(idx, -1, `${file} must contain an "Avoid phrases like:" block`);
  return quotedPhrases(content.slice(idx));
}

// restraint.txt: the parenthetical after "banned phrases". Phrases wrap across
// lines, so collapse whitespace before isolating the (...) group.
function capListFromJudge() {
  const content = fs.readFileSync(RESTRAINT_JUDGE, 'utf8');
  const idx = content.indexOf('banned phrases');
  assert.notEqual(idx, -1, 'restraint.txt must reference "banned phrases"');
  const collapsed = content.slice(idx).replace(/\s+/g, ' ');
  const paren = collapsed.match(/\(([^)]*)\)/);
  assert.ok(paren, 'restraint.txt must list the banned phrases in a parenthetical');
  return quotedPhrases(paren[1]);
}

test('every prompt is discovered (guards against an empty glob)', () => {
  // A readdir that silently returned [] would make the per-prompt tests below
  // vacuously pass — the whole check would evaporate without failing.
  assert.ok(
    PROMPT_FILES.length >= 3,
    `expected >=3 prompt files in prompts/, got ${PROMPT_FILES.length}: ${PROMPT_FILES.join(', ')}`,
  );
});

for (const file of PROMPT_FILES) {
  test(`avoid-list (${file}) and cap-list (restraint.txt) are identical`, () => {
    const avoid = avoidListFromPrompt(file);
    const cap = capListFromJudge();

    // Both lists are real and non-trivial (guards against a parser that
    // silently returns []).
    assert.ok(avoid.length >= 5, `expected >=5 avoid phrases, got ${avoid.length}`);
    assert.ok(cap.length >= 5, `expected >=5 banned phrases, got ${cap.length}`);

    // Order-independent set equality.
    assert.deepEqual(
      [...avoid].sort(),
      [...cap].sort(),
      `prompts/${file} avoid-list must equal judges/restraint.txt cap-list`,
    );
  });
}

test('the reduced-role gate carries no third copy of the banned phrases', () => {
  const cap = capListFromJudge();
  const gateSource = fs.readFileSync(REDUCED_ROLE, 'utf8');
  for (const phrase of cap) {
    assert.ok(
      !gateSource.includes(phrase),
      `reduced-role.js must not embed banned phrase "${phrase}" — single source of truth`,
    );
  }
});
