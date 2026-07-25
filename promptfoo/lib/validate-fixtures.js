// Schema-check every fixture in fixtures/*.json — run by `npm run validate`
// alongside `promptfoo validate`, so a malformed fixture (or an iOS export
// that drifts from the contract) fails the same keyless check that guards the
// promptfoo config. Exits non-zero on the first invalid file set; prints
// every error for every file first.
//
// With explicit file paths as arguments it checks THOSE instead of the
// fixtures/ glob — how the Swift FixtureExportTests cross-check the iOS
// encoder's actual output against this same validator. No arguments keeps
// `npm run validate` behavior unchanged.

const fs = require('fs');
const path = require('path');

const { validateFixture } = require('./fixture-schema.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function main() {
  const args = process.argv.slice(2);
  const targets =
    args.length > 0
      ? args.map((p) => ({ label: p, fullPath: path.resolve(p) }))
      : fs
          .readdirSync(FIXTURES_DIR)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => ({ label: `fixtures/${f}`, fullPath: path.join(FIXTURES_DIR, f) }));

  if (targets.length === 0) {
    console.log('validate-fixtures: no fixtures/*.json to check');
    return 0;
  }

  let failed = 0;
  for (const { label, fullPath } of targets) {
    let errors;
    try {
      errors = validateFixture(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
    } catch (err) {
      errors = [`not parseable as JSON: ${err.message}`];
    }
    if (errors.length === 0) {
      console.log(`✓ ${label}`);
    } else {
      failed += 1;
      console.error(`✗ ${label}`);
      for (const e of errors) console.error(`    ${e}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
