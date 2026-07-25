// Captured-session fixture schema — the contract between the iOS export and
// providers/replay.js.
//
// A fixture is a real (or, for now, hand-authored) dictation session: session
// metadata plus the ordered thinker utterances as the STT text ACTUALLY
// produced — fillers, restarts, missing punctuation and all. The replay
// provider feeds these to the listener under test verbatim, so a fixture cell
// scores the listener on live-shaped input instead of the simulator's clean
// prose (the clean-text upper bound of
// docs/findings/on-device-text-quality.md §6).
//
// The human-readable contract lives in fixtures/README.md; this module is the
// executable version of it. Hand-rolled (no JSON-schema dependency — the
// harness deliberately carries only promptfoo) and shared by three callers so
// none can drift: providers/replay.js validates before replaying,
// lib/validate-fixtures.js schema-checks fixtures/*.json under `npm run
// validate`, and test/fixture-schema.test.js pins the rules.

const SCHEMA_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Validate a parsed fixture object. Returns an array of human-readable error
// strings — empty means valid. Collects every problem instead of stopping at
// the first, so a malformed export surfaces all at once.
function validateFixture(fixture) {
  const errors = [];
  if (!isPlainObject(fixture)) {
    return ['fixture must be a JSON object'];
  }

  if (fixture.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(fixture.schemaVersion)}`,
    );
  }

  // session — metadata block. `source` is honest provenance: replay results
  // mean different things for a real device capture vs a hand-authored
  // placeholder, and nothing downstream can tell them apart except this field.
  if (!isPlainObject(fixture.session)) {
    errors.push('session must be an object ({ id, date, source, knobs? })');
  } else {
    const s = fixture.session;
    if (!isNonEmptyString(s.id)) errors.push('session.id must be a non-empty string');
    if (!isNonEmptyString(s.date) || Number.isNaN(Date.parse(s.date))) {
      errors.push('session.date must be an ISO-8601 date string');
    }
    if (!isNonEmptyString(s.source)) {
      errors.push(
        'session.source must be a non-empty string (e.g. "ios-sfspeechrecognizer", "hand-authored")',
      );
    }
    if (s.knobs !== undefined && !isPlainObject(s.knobs)) {
      errors.push('session.knobs, when present, must be an object');
    }
  }

  // utterances — the ordered thinker turns. Text is required and non-empty;
  // timing is optional (the export should include it when it has it, since the
  // live gate routes on timing and a future harness may too).
  if (!Array.isArray(fixture.utterances) || fixture.utterances.length === 0) {
    errors.push('utterances must be a non-empty array');
  } else {
    fixture.utterances.forEach((u, i) => {
      if (!isPlainObject(u)) {
        errors.push(`utterances[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(u.text)) {
        errors.push(`utterances[${i}].text must be a non-empty string`);
      }
      for (const key of ['startSeconds', 'endSeconds']) {
        if (u[key] !== undefined && (!Number.isFinite(u[key]) || u[key] < 0)) {
          errors.push(`utterances[${i}].${key}, when present, must be a non-negative number`);
        }
      }
      if (
        Number.isFinite(u.startSeconds) &&
        Number.isFinite(u.endSeconds) &&
        u.endSeconds < u.startSeconds
      ) {
        errors.push(`utterances[${i}].endSeconds must be >= startSeconds`);
      }
    });
  }

  // landingIndex — which utterance ends the dictation (0-based). Optional;
  // the replay provider defaults to the last utterance, mirroring
  // providers/multi-turn.js where the last simulator turn is the landing.
  if (fixture.landingIndex !== undefined) {
    const n = Array.isArray(fixture.utterances) ? fixture.utterances.length : 0;
    if (!Number.isInteger(fixture.landingIndex) || fixture.landingIndex < 0 || fixture.landingIndex >= n) {
      errors.push(
        `landingIndex, when present, must be an integer in [0, ${Math.max(n - 1, 0)}] (0-based utterance index)`,
      );
    }
  }

  return errors;
}

module.exports = { SCHEMA_VERSION, validateFixture };
