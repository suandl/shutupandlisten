// Tests for the assembler's timing helpers (assemble.ts).
//
// probeDuration is pinned against a real clip generated with the bundled ffmpeg:
// an earlier cut read execFileSync's return value (stdout only) while ffmpeg prints
// its `Duration:` banner to stderr, so every probe returned 0 and narration was
// silently truncated to the frame's base duration. This test fails on that bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ffmpegPath from 'ffmpeg-static';
import { baseDuration, probeDuration, type Frame } from './assemble.ts';

const frame = (over: Partial<Frame>): Frame => ({
  file: '01-x.png',
  narration: 'x',
  duration: 3.5,
  observation: null,
  proof: 'passed',
  severity: null,
  ...over,
});

test('baseDuration: duration as-is, +1s with an observation, 3.5s fallback', () => {
  assert.equal(baseDuration(frame({})), 3.5);
  assert.equal(baseDuration(frame({ duration: 5 })), 5);
  assert.equal(baseDuration(frame({ observation: 'proof failed' })), 4.5);
  assert.equal(baseDuration(frame({ duration: NaN })), 3.5);
  assert.equal(baseDuration(frame({ duration: 0 })), 3.5);
});

test('probeDuration reads the real duration of a successful probe (stderr banner)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'su-demo-test-'));
  try {
    const clip = path.join(tmp, 'tone.m4a');
    execFileSync(
      ffmpegPath as unknown as string,
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1.2', '-c:a', 'aac', clip],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const d = probeDuration(clip);
    assert.ok(d > 1.0 && d < 1.5, `expected ~1.2s, got ${d}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeDuration: 0 for a file that is not media', () => {
  assert.equal(probeDuration('/nonexistent/nothing.mp3'), 0);
});
