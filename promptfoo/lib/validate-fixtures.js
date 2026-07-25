// Schema-check every fixture in fixtures/*.json — run by `npm run validate`
// alongside `promptfoo validate`, so a malformed fixture (or a future iOS
// export that drifts from the contract) fails the same keyless check that
// guards the promptfoo config. Exits non-zero on the first invalid file set;
// prints every error for every file first.

const fs = require('fs');
const path = require('path');

const { validateFixture } = require('./fixture-schema.js');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function main() {
  const files = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.log('validate-fixtures: no fixtures/*.json to check');
    return 0;
  }

  let failed = 0;
  for (const file of files) {
    const fullPath = path.join(FIXTURES_DIR, file);
    let errors;
    try {
      errors = validateFixture(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
    } catch (err) {
      errors = [`not parseable as JSON: ${err.message}`];
    }
    if (errors.length === 0) {
      console.log(`✓ fixtures/${file}`);
    } else {
      failed += 1;
      console.error(`✗ fixtures/${file}`);
      for (const e of errors) console.error(`    ${e}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
