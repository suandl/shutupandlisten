// Banned-phrase sync — keyless, no model.
//
// U2 test scenario: the avoid-list in prompts/chatgpt.md and the score-capping
// list in judges/restraint.txt must stay identical, and there must be no third
// copy of the list in the reduced-role gate. The listener prompt tells the
// model what NOT to say; the judge caps the score when it says it anyway. If
// the two drift, the harness rewards or punishes phrases the prompt never
// mentioned. The gate emits only acks, so it must not carry its own copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTFOO_DIR = path.resolve(__dirname, '..');

const CHATGPT_PROMPT = path.join(REPO_ROOT, 'prompts', 'chatgpt.md');
const RESTRAINT_JUDGE = path.join(PROMPTFOO_DIR, 'judges', 'restraint.txt');
const REDUCED_ROLE = path.join(PROMPTFOO_DIR, 'providers', 'reduced-role.js');

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

// chatgpt.md: the bullets under "Avoid phrases like:" to end of file.
function avoidListFromPrompt() {
  const content = fs.readFileSync(CHATGPT_PROMPT, 'utf8');
  const idx = content.indexOf('Avoid phrases like:');
  assert.notEqual(idx, -1, 'chatgpt.md must contain an "Avoid phrases like:" block');
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

test('avoid-list (chatgpt.md) and cap-list (restraint.txt) are identical', () => {
  const avoid = avoidListFromPrompt();
  const cap = capListFromJudge();

  // Both lists are real and non-trivial (guards against a parser that silently
  // returns []).
  assert.ok(avoid.length >= 5, `expected >=5 avoid phrases, got ${avoid.length}`);
  assert.ok(cap.length >= 5, `expected >=5 banned phrases, got ${cap.length}`);

  // Order-independent set equality.
  assert.deepEqual(
    [...avoid].sort(),
    [...cap].sort(),
    'prompts/chatgpt.md avoid-list must equal judges/restraint.txt cap-list',
  );
});

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
