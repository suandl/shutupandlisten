// MP4 assembly — the output half of the capture engine (su-lou.4.1).
//
// Turns the captured proof frames (NN-*.png) + manifest.json into a narrated MP4,
// the way signal-loom's assembleDemoVideo.ts does, but self-contained and lower-
// friction for su:
//   • Video: `ffmpeg-static` (a bundled binary — this host has no system ffmpeg).
//   • Captions: NONE here. The driver burns the caption into each frame as a DOM
//     overlay before screenshotting (crisper text in the app's own font), so this
//     build of ffmpeg needs no `drawtext`/freetype — a plain concat + libx264 pass.
//   • Narration: OpenAI `tts-1`/`nova`, OPTIONAL. With no OPENAI_API_KEY (CI, a
//     fresh clone) or on ANY narration failure it degrades to a SILENT mp4 — the
//     silent path is the contract, narration is a best-effort add-on that can never
//     break it (the whole narration build is wrapped and falls back to silent).
//
// Timing mirrors signal-loom: a frame shows for its manifest `duration` (+1s when it
// carries an `observation`); with narration a frame is stretched to
// max(base, clip + 0.5s) so speech is never clipped.

import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Frame {
  file: string;
  narration: string;
  duration: number;
  observation: string | null;
  proof: 'passed' | 'adapted' | 'failed';
  severity: 'warning' | 'error' | null;
}

export interface Manifest {
  title: string;
  frames: Frame[];
}

export interface AssembleOptions {
  /** Directory holding the NN-*.png frames + manifest.json. */
  capturesDir: string;
  /** Final mp4 path (silent). A narrated build lands beside it as `<name>-narrated.mp4`. */
  outputPath: string;
  /** Force silent even when OPENAI_API_KEY is set. */
  noNarrate?: boolean;
  /** Progress sink (defaults to console.log). */
  log?: (m: string) => void;
}

export interface AssembleResult {
  /** The video that was produced (narrated path if narration succeeded, else the silent one). */
  outputPath: string;
  narrated: boolean;
}

const FF = ffmpegPath as unknown as string;

function run(args: string[]): string {
  // stdio captured; ffmpeg writes progress to stderr, so fold it in for probing.
  return execFileSync(FF, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '';
}

/** Base seconds a frame is shown before narration stretch: its duration, +1s if it has an observation. */
export function baseDuration(f: Frame): number {
  const d = Number.isFinite(f.duration) && f.duration > 0 ? f.duration : 3.5;
  return d + (f.observation ? 1 : 0);
}

/** Write the concat-demuxer list; the last file is repeated with no duration (ffmpeg concat truncates the final frame otherwise). */
function writeConcat(listPath: string, frames: { abs: string; duration: number }[]): void {
  const lines: string[] = [];
  for (const f of frames) {
    lines.push(`file '${f.abs.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${f.duration.toFixed(3)}`);
  }
  const last = frames[frames.length - 1];
  if (last) lines.push(`file '${last.abs.replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, lines.join('\n') + '\n');
}

/** Probe a media file's duration (seconds) from ffmpeg's stderr banner. 0 if unknown. */
function probeDuration(file: string): number {
  let out = '';
  try {
    out = execFileSync(FF, ['-i', file, '-hide_banner', '-f', 'null', '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e as { stderr?: string }).stderr ?? '';
  }
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

/** One OpenAI TTS clip → mp3 file. Returns false on any failure (caller degrades to silence). Never logs the key. */
async function ttsClip(text: string, outFile: string, apiKey: string): Promise<boolean> {
  const model = process.env.DEMO_TTS_MODEL || 'tts-1';
  const voice = process.env.DEMO_TTS_VOICE || 'nova';
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return false;
    writeFileSync(outFile, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a narration track aligned to the frames. Returns the mp3 path + the
 * (possibly stretched) per-frame durations, or null to fall back to silent. Every
 * failure mode — no key, a failed clip, a bad probe — collapses to null so the
 * silent path always remains available.
 */
async function buildNarration(
  frames: Frame[],
  tmp: string,
  log: (m: string) => void,
): Promise<{ audioPath: string; durations: number[] } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  log('narration: OPENAI_API_KEY set — synthesizing per-frame narration…');

  const segDurations: number[] = [];
  const segFiles: (string | null)[] = [];
  for (let i = 0; i < frames.length; i++) {
    const text = frames[i].narration?.trim();
    const base = baseDuration(frames[i]);
    if (!text) {
      segDurations.push(base);
      segFiles.push(null);
      continue;
    }
    const clip = path.join(tmp, `tts-${String(i).padStart(3, '0')}.mp3`);
    const ok = await ttsClip(text, clip, apiKey);
    if (!ok) {
      log(`narration: clip ${i} failed — reverting to a silent video`);
      return null;
    }
    const clipDur = probeDuration(clip);
    segDurations.push(Math.max(base, clipDur + 0.5));
    segFiles.push(clip);
  }

  // Pad each clip (or generate silence) to its frame duration, then concat.
  const padded: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = segDurations[i];
    const out = path.join(tmp, `seg-${String(i).padStart(3, '0')}.m4a`);
    if (segFiles[i]) {
      run(['-y', '-i', segFiles[i] as string, '-af', `apad=whole_dur=${dur.toFixed(3)}`, '-t', dur.toFixed(3), '-c:a', 'aac', out]);
    } else {
      run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', dur.toFixed(3), '-c:a', 'aac', out]);
    }
    padded.push(out);
  }
  const audioList = path.join(tmp, 'audio-concat.txt');
  writeFileSync(audioList, padded.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const audioPath = path.join(tmp, 'narration.m4a');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', audioList, '-c:a', 'aac', audioPath]);
  return { audioPath, durations: segDurations };
}

/**
 * Assemble the captured frames into an MP4. Always produces the silent video at
 * `outputPath`; if narration succeeds, also writes `<name>-narrated.mp4` and returns
 * that as the result.
 */
export async function assembleVideo(opts: AssembleOptions): Promise<AssembleResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const manifestPath = path.join(opts.capturesDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  if (!manifest.frames?.length) throw new Error(`assemble: manifest has no frames (${manifestPath})`);

  for (const f of manifest.frames) {
    const abs = path.join(opts.capturesDir, f.file);
    if (!existsSync(abs)) throw new Error(`assemble: missing frame ${abs}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'su-demo-'));
  try {
    // Optional narration first — it may stretch per-frame durations to fit speech.
    let durations = manifest.frames.map(baseDuration);
    let narration: { audioPath: string; durations: number[] } | null = null;
    if (!opts.noNarrate) {
      narration = await buildNarration(manifest.frames, tmp, log);
      if (narration) durations = narration.durations;
    }

    const concatList = path.join(tmp, 'frames.txt');
    writeConcat(
      concatList,
      manifest.frames.map((f, i) => ({ abs: path.join(opts.capturesDir, f.file), duration: durations[i] })),
    );

    // Even dimensions (yuv420p/libx264 require them) + a constant 30fps still track.
    const vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p';
    log(`assemble: encoding ${manifest.frames.length} frames → ${opts.outputPath}`);
    run(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-an', opts.outputPath]);

    if (!narration) return { outputPath: opts.outputPath, narrated: false };

    const narratedPath = opts.outputPath.replace(/\.mp4$/, '-narrated.mp4');
    try {
      run(['-y', '-i', opts.outputPath, '-i', narration.audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', narratedPath]);
      log(`assemble: narrated video → ${narratedPath}`);
      return { outputPath: narratedPath, narrated: true };
    } catch (e) {
      log(`assemble: mux failed (${(e as Error).message}) — keeping the silent video`);
      try {
        if (existsSync(narratedPath)) rmSync(narratedPath);
      } catch {
        /* ignore */
      }
      return { outputPath: opts.outputPath, narrated: false };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
