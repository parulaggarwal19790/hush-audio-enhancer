// PCM helpers: process runner, decode/encode, voice detection, cutting, waveform peaks.
// Everything inside the pipeline is 48 kHz mono 16-bit.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const SR = 48000;

export function run(cmd, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-24000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr: err });
      const tail = err.trim().split('\n').slice(-3).join(' ').slice(-400);
      reject(new Error(`${basename(cmd)} failed (exit ${code}): ${tail || 'no output'}`));
    });
  });
}

export function ffmpeg(args, opts) {
  return run('ffmpeg', ['-hide_banner', '-nostdin', '-nostats', '-y', ...args], opts);
}

export async function readPcm(file, signal) {
  const { stdout } = await ffmpeg(
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', String(SR), '-'],
    { signal },
  );
  const bytes = stdout.length & ~1;
  return new Int16Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + bytes));
}

export async function writeWav(file, pcm) {
  const bytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  await writeFile(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, bytes)]));
}

// RMS level in dBFS for each consecutive frame.
export function frameLevels(pcm, frame) {
  const count = Math.floor(pcm.length / frame);
  const db = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * frame;
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const v = pcm[offset + j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frame) / 32768;
    db[i] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }
  return db;
}

function quantile(sorted, q) {
  if (!sorted.length) return -100;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function rmsDb(pcm) {
  return pcm.length ? frameLevels(pcm, pcm.length)[0] : -100;
}

// Level of the quietest stretches: what's left when nobody is talking.
export function noiseFloor(pcm) {
  const levels = frameLevels(pcm, Math.round(SR * 0.05)).sort();
  return Math.round(quantile(levels, 0.1) * 10) / 10;
}

// Frame levels of the band where speech lives. A 180 Hz high-pass keeps hum and
// rumble, which denoisers tend to leave a trace of, from being counted as voice.
function speechBandLevels(pcm, frame) {
  const w0 = (2 * Math.PI * 180) / SR;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + Math.cos(w0)) / 2 / a0;
  const b1 = -(1 + Math.cos(w0)) / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;

  const count = Math.floor(pcm.length / frame);
  const db = new Float32Array(count);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < count; i++) {
    const offset = i * frame;
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const x = pcm[offset + j];
      const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      sum += y * y;
    }
    const rms = Math.sqrt(sum / frame) / 32768;
    db[i] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }
  return db;
}

// Energy-based voice detection on denoised audio, with a threshold adapted to
// this recording: just above its noise floor, but never further than 30 dB
// below the loudest speech. Pass the `original` recording too, and a take whose
// loudest moments were mostly removed by denoising counts as having no voice.
// Returns voiced regions in samples.
export function detectVoice(pcm, original = null) {
  const FRAME = Math.round(SR * 0.01);
  const levels = speechBandLevels(pcm, FRAME);
  const sorted = Float32Array.from(levels).sort();
  const speech = quantile(sorted, 0.99);
  const floor = quantile(sorted, 0.1);
  if (speech < -62) return [];
  if (original && quantile(speechBandLevels(original, FRAME).sort(), 0.99) - speech > 15) return [];

  const threshold = Math.min(speech - 15, Math.max(speech - 30, floor + 10));

  let runs = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const voiced = i < levels.length && levels[i] > threshold;
    if (voiced && start < 0) start = i;
    if (!voiced && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }

  // Drop clicks, bridge the short gaps inside words and phrases, then drop
  // anything still too short to be a word.
  runs = runs.filter(([a, b]) => b - a > 2);
  const merged = [];
  for (const [a, b] of runs) {
    const last = merged.at(-1);
    if (last && a - last[1] <= 25) last[1] = b;
    else merged.push([a, b]);
  }
  return merged
    .filter(([a, b]) => b - a >= 9)
    .map(([a, b]) => ({ start: a * FRAME, end: Math.min(pcm.length, b * FRAME) }));
}

const HEAD_PAD = Math.round(SR * 0.12);
const TAIL_PAD = Math.round(SR * 0.22);
const MAX_PAUSE = Math.round(SR * 0.45);

// Decide which parts of the recording to keep.
//   edges: one segment from just before the first word to just after the last
//   tight: same, and pauses longer than MAX_PAUSE are shortened to MAX_PAUSE
export function planSegments(regions, total, mode) {
  if (mode === 'off' || !regions.length) return [{ start: 0, end: total }];

  const padded = regions.map((r) => ({
    start: Math.max(0, r.start - HEAD_PAD),
    end: Math.min(total, r.end + TAIL_PAD),
  }));

  if (mode === 'edges') return [{ start: padded[0].start, end: padded.at(-1).end }];

  const segments = [{ ...padded[0] }];
  for (const next of padded.slice(1)) {
    const last = segments.at(-1);
    const gap = next.start - last.end;
    if (gap > MAX_PAUSE) {
      last.end += MAX_PAUSE >> 1;
      segments.push({ start: next.start - (MAX_PAUSE >> 1), end: next.end });
    } else {
      last.end = Math.max(last.end, next.end);
    }
  }
  return segments;
}

// Join the kept segments, with a short fade at every boundary so cuts never click.
export function cut(pcm, segments) {
  const total = segments.reduce((n, s) => n + (s.end - s.start), 0);
  const out = new Int16Array(total);
  const FADE = Math.round(SR * 0.006);
  let pos = 0;
  for (const { start, end } of segments) {
    const len = end - start;
    out.set(pcm.subarray(start, end), pos);
    const fade = Math.min(FADE, len >> 1);
    for (let i = 0; i < fade; i++) {
      const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      out[pos + i] *= gain;
      out[pos + len - 1 - i] *= gain;
    }
    pos += len;
  }
  return out;
}

// Peak amplitude (0..1) per bucket, for drawing waveforms.
export function peaks(pcm, buckets = 480) {
  const out = new Array(buckets).fill(0);
  if (!pcm.length) return out;
  const step = pcm.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * step);
    const to = Math.max(from + 1, Math.floor((b + 1) * step));
    let max = 0;
    for (let i = from; i < to; i++) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > max) max = v;
    }
    out[b] = Math.round((max / 32768) * 1000) / 1000;
  }
  return out;
}
