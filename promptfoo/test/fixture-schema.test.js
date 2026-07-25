// Fixture schema — keyless, no model, no promptfoo runtime.
//
// fixtures/README.md is the CONTRACT a future iOS export must meet;
// lib/fixture-schema.js is its executable form. These tests pin the rules the
// contract states — and pin that every shipped fixture in fixtures/ actually
// meets it, which is the same check `npm run validate` runs
// (lib/validate-fixtures.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateFixture, SCHEMA_VERSION } = require('../lib/fixture-schema.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

// A minimal valid fixture to mutate from.
function valid() {
  return {
    schemaVersion: SCHEMA_VERSION,
    session: { id: 's-1', date: '2026-07-25T00:00:00Z', source: 'hand-authored' },
    utterances: [
      { text: 'so the idea is um a thing' },
      { text: 'and uh,' },
      { text: "that's basically it" },
    ],
    landingIndex: 2,
  };
}

test('every shipped fixture in fixtures/ meets the contract', () => {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2, 'the example fixtures must exist');
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    assert.deepEqual(validateFixture(fixture), [], `fixtures/${file} must validate`);
    // Honesty check on the placeholders: a hand-authored fixture must SAY so —
    // in the source field and in the filename — so it can never be quoted as a
    // device capture.
    if (fixture.session.source === 'hand-authored') {
      assert.ok(
        file.startsWith('hand-authored-'),
        `hand-authored fixture ${file} must carry the hand-authored- filename prefix`,
      );
    }
  }
});

test('a minimal valid fixture passes with no errors', () => {
  assert.deepEqual(validateFixture(valid()), []);
});

test('landingIndex is optional', () => {
  const f = valid();
  delete f.landingIndex;
  assert.deepEqual(validateFixture(f), []);
});

test('non-objects and wrong schemaVersion are rejected', () => {
  assert.deepEqual(validateFixture(null), ['fixture must be a JSON object']);
  assert.deepEqual(validateFixture([]), ['fixture must be a JSON object']);
  const f = valid();
  f.schemaVersion = 2;
  assert.ok(validateFixture(f).some((e) => /schemaVersion must be 1/.test(e)));
});

test('session metadata is required: id, parseable date, source', () => {
  const noSession = valid();
  delete noSession.session;
  assert.ok(validateFixture(noSession).some((e) => /session must be an object/.test(e)));

  const f = valid();
  f.session = { id: '', date: 'not-a-date', source: '' };
  const errors = validateFixture(f);
  assert.ok(errors.some((e) => /session\.id/.test(e)));
  assert.ok(errors.some((e) => /session\.date/.test(e)));
  assert.ok(errors.some((e) => /session\.source/.test(e)));
});

test('utterances must be a non-empty array of non-empty texts', () => {
  const empty = valid();
  empty.utterances = [];
  assert.ok(validateFixture(empty).some((e) => /non-empty array/.test(e)));

  const blank = valid();
  blank.utterances[1] = { text: '   ' };
  assert.ok(validateFixture(blank).some((e) => /utterances\[1\]\.text/.test(e)));
});

test('utterance timing, when present, must be sane', () => {
  const f = valid();
  f.utterances[0] = { text: 'ok', startSeconds: 5, endSeconds: 2 };
  assert.ok(validateFixture(f).some((e) => /endSeconds must be >= startSeconds/.test(e)));

  const g = valid();
  g.utterances[0] = { text: 'ok', startSeconds: -1 };
  assert.ok(validateFixture(g).some((e) => /startSeconds/.test(e)));
});

test('landingIndex must point at a real utterance', () => {
  for (const bad of [-1, 3, 1.5, 'last']) {
    const f = valid();
    f.landingIndex = bad;
    assert.ok(
      validateFixture(f).some((e) => /landingIndex/.test(e)),
      `landingIndex ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('every problem is reported at once, not just the first', () => {
  const f = { schemaVersion: 9, session: {}, utterances: [] };
  assert.ok(validateFixture(f).length >= 3, 'all violations surface together');
});
