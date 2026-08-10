// Tests for the assembler's timing helpers (assemble.ts).
//
// probeDuration is pinned against ffmpeg's real output shape: an earlier cut read
// execFileSync's return value (stdout only) while ffmpeg prints its `Duration:` banner
// to stderr, so every probe returned 0 and narration was silently truncated to the
// frame's base duration. These tests fail on that bug.
//
// The regression is pinned TWICE, deliberately:
//   • against a STUB ffmpeg that reproduces the stdout/stderr split exactly — hermetic,
//     so it runs on every host and the bug cannot regress unnoticed;
//   • against the REAL binary on a host that has one — the end-to-end check that our
//     reading of ffmpeg's actual banner format is still right.
// The real-binary tests skip cleanly when ffmpeg is un-provisioned (su-jfj1): npm ≥12
// blocks `ffmpeg-static`'s install script unless the package is in `allowScripts`, so a
// plain `npm ci` yields a populated package directory with no binary in it. Skipping
// there is what keeps every `web/` merge gate from reporting a failure that is not real;
// `npm run provision:ffmpeg` fetches the binary and un-skips them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { baseDuration, ffmpegBin, probeDuration, type Frame } from './assemble.ts';

const frame = (over: Partial<Frame>): Frame => ({
  file: '01-x.png',
  narration: 'x',
  duration: 3.5,
  observation: null,
  proof: 'passed',
  severity: null,
  ...over,
});

/** Skip reason for the tests that need a real ffmpeg, or false when one is provisioned. */
const needsFfmpeg = ffmpegBin()
  ? false
  : 'ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static\'s install script) — `npm run provision:ffmpeg`';

/**
 * A stand-in ffmpeg writing a fixed stdout/stderr split, which is the only thing
 * probeDuration reads. Node (not sh) so the payloads embed as JSON with no quoting
 * hazard. Returns the executable's path.
 */
function stubFfmpeg(dir: string, out: { stdout?: string; stderr?: string; code?: number }): string {
  const p = path.join(dir, 'ffmpeg-stub.mjs');
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(${JSON.stringify(out.stdout ?? '')});\n` +
      `process.stderr.write(${JSON.stringify(out.stderr ?? '')});\n` +
      `process.exit(${out.code ?? 0});\n`,
    { mode: 0o755 },
  );
  return p;
}

/** Run `fn` with a scratch dir that is always cleaned up. */
function withTmp<T>(fn: (dir: string) => T): T {
  const tmp = mkdtempSync(path.join(tmpdir(), 'su-demo-test-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('baseDuration: duration as-is, +1s with an observation, 3.5s fallback', () => {
  assert.equal(baseDuration(frame({})), 3.5);
  assert.equal(baseDuration(frame({ duration: 5 })), 5);
  assert.equal(baseDuration(frame({ observation: 'proof failed' })), 4.5);
  assert.equal(baseDuration(frame({ duration: NaN })), 3.5);
  assert.equal(baseDuration(frame({ duration: 0 })), 3.5);
});

test('probeDuration reads the Duration banner from STDERR, not stdout', () => {
  withTmp((tmp) => {
    // The exact split that broke it: the banner is on stderr, and stdout carries
    // nothing usable. A stdout-only read (the old execFileSync cut) sees no match here
    // and returns 0, so this test is what fails if that regresses.
    const bin = stubFfmpeg(tmp, {
      stdout: 'stdout carries no Duration\n',
      stderr:
        "Input #0, mov,mp4,m4a, from 'tone.m4a':\n" +
        '  Duration: 00:00:01.20, start: 0.000000, bitrate: 2 kb/s\n',
    });
    assert.equal(probeDuration('/any/clip.m4a', bin), 1.2);
  });
});

test('probeDuration parses hours, minutes and seconds out of the banner', () => {
  withTmp((tmp) => {
    const bin = stubFfmpeg(tmp, { stderr: '  Duration: 01:02:03.50, start: 0.000000\n' });
    assert.equal(probeDuration('/any/clip.m4a', bin), 3723.5);
  });
});

test('probeDuration: 0 when the probe emits no Duration banner', () => {
  withTmp((tmp) => {
    const bin = stubFfmpeg(tmp, {
      stderr: "nothing.mp3: No such file or directory\n",
      code: 1,
    });
    assert.equal(probeDuration('/nonexistent/nothing.mp3', bin), 0);
  });
});

test('probeDuration: 0 when no ffmpeg is provisioned', () => {
  // The degradation that keeps an un-provisioned host out of the narration path:
  // "duration unknown", which callers already fall back from to the base duration.
  assert.equal(probeDuration('/any/clip.m4a', null), 0);
});

test('probeDuration reads the real duration of a successful probe (stderr banner)', {
  skip: needsFfmpeg,
}, () => {
  withTmp((tmp) => {
    const clip = path.join(tmp, 'tone.m4a');
    execFileSync(
      ffmpegBin() as string,
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1.2', '-c:a', 'aac', clip],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const d = probeDuration(clip);
    assert.ok(d > 1.0 && d < 1.5, `expected ~1.2s, got ${d}`);
  });
});

test('probeDuration: 0 for a file that is not media', { skip: needsFfmpeg }, () => {
  assert.equal(probeDuration('/nonexistent/nothing.mp3'), 0);
});
