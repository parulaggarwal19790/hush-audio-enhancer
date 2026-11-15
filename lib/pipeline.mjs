// The signal chain: extract -> denoise -> trim -> master -> name -> export.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { denoiserPath, hasDenoiser } from '../scripts/setup.mjs';
import { SR, cut, detectVoice, ffmpeg, noiseFloor, peaks, planSegments, readPcm, rmsDb, run, writeWav } from './audio.mjs';
import { LISTEN_SECONDS, namesFromSpeech, transcribe } from './transcribe.mjs';

export const STAGES = ['extract', 'denoise', 'trim', 'master', 'name', 'export'];

const CHOICES = {
  denoise: ['off', 'light', 'studio', 'deep'],
  trim: ['off', 'edges', 'tight'],
  polish: ['clean', 'studio', 'radio'],
  format: ['mp3', 'wav'],
  name: ['original', 'spoken'],
};
export const DEFAULTS = { denoise: 'studio', trim: 'edges', polish: 'studio', format: 'mp3', name: 'spoken' };

export function normalizeSettings(input) {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(CHOICES)) {
    if (CHOICES[key].includes(input?.[key])) settings[key] = input[key];
  }
  return settings;
}

// Each polish preset is an ffmpeg filter chain plus a loudness target.
const POLISH = {
  clean: { lufs: -16, chain: ['highpass=f=60'] },
  studio: {
    lufs: -16,
    chain: [
      'highpass=f=80',
      'equalizer=f=260:t=q:w=1.1:g=-2.5', // clear the low-mid mud
      'equalizer=f=3600:t=q:w=0.9:g=2', // presence
      'highshelf=f=9500:g=2.5', // air
      'deesser=i=0.35:m=0.5:f=0.5',
      'acompressor=threshold=-21dB:ratio=3:attack=8:release=140:knee=6',
    ],
  },
  radio: {
    lufs: -14,
    chain: [
      'highpass=f=85',
      'lowshelf=f=120:g=2', // chest
      'equalizer=f=300:t=q:w=1:g=-3.5',
      'equalizer=f=4200:t=q:w=0.8:g=3',
      'highshelf=f=10000:g=3.5',
      'deesser=i=0.5:m=0.6:f=0.5',
      'acompressor=threshold=-24dB:ratio=4.5:attack=5:release=110:knee=8',
    ],
  },
};
const LIMITER = 'alimiter=limit=0.84:attack=5:release=60:level=0'; // -1.5 dBFS ceiling

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

// ---- DeepFilterNet (optional neural engine) --------------------------------

let neural; // undefined = not probed yet, null = unavailable

// Reads the binary's own --help, so we only ever pass flags this build has.
export async function probeNeural() {
  neural = null;
  if (!(await hasDenoiser())) return null;
  try {
    const { stdout, stderr } = await run(denoiserPath, ['--help']);
    const help = `${stdout}${stderr}`;
    neural = {
      atten: ['--atten-lim-db', '--atten-lim'].find((flag) => help.includes(flag)) ?? null,
      postFilter: help.includes('--pf'),
      compensateDelay: help.includes('--compensate-delay'),
    };
  } catch (err) {
    console.warn(`DeepFilterNet is installed but would not run (${err.message}). Using the built-in denoiser.`);
  }
  return neural;
}

async function neuralDenoise(job, strength, signal) {
  const outDir = join(job.dir, 'neural');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir);

  const args = [];
  if (neural.compensateDelay) args.push('--compensate-delay');
  if (strength === 'light' && neural.atten) args.push(neural.atten, '12');
  if (strength === 'deep' && neural.postFilter) args.push('--pf');
  await run(denoiserPath, [...args, '-o', outDir, join(job.dir, 'raw.wav')], { signal });

  const produced = (await readdir(outDir)).find((name) => name.endsWith('.wav'));
  if (!produced) throw new Error('DeepFilterNet produced no output');
  const pcm = await readPcm(join(outDir, produced), signal);
  await rm(outDir, { recursive: true, force: true });
  return pcm;
}

function builtinDenoise(pcm, strength, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./denoise-worker.mjs', import.meta.url), {
      workerData: { pcm, strength },
    });
    const onAbort = () => {
      worker.terminate();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) reject(new Error(`Denoiser stopped unexpectedly (exit ${code})`));
    });
  });
}

// ---- measurement helpers ----------------------------------------------------

function parseLoudness(stderr) {
  const matches = [...stderr.matchAll(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

async function measurePeak(source, signal) {
  const { stderr } = await ffmpeg(
    ['-i', source, '-map', '0:a:0', '-vn', '-af', 'aformat=channel_layouts=mono,volumedetect', '-f', 'null', '-'],
    { signal },
  );
  const match = /max_volume:\s+(-?\d+(?:\.\d+)?) dB/.exec(stderr);
  return match ? Number(match[1]) : null;
}

// ---- the pipeline -----------------------------------------------------------

// job: { dir, source, settings, base }. `stage(name)` reports progress,
// `note(text)` adds a line of detail to the current stage, and `patch(fields)`
// publishes partial results as they become available.
// Resolves to the finished output: { file, ext, ...stats }.
export async function processJob(job, { stage, note, patch, signal }) {
  const { settings, dir } = job;
  const at = (name) => join(dir, name);
  if (neural === undefined) await probeNeural();

  // 1. Extract: pull the audio track out as 48 kHz mono, peaking at -3 dBFS so
  //    quiet recordings use the full 16-bit range before any processing.
  stage('extract');
  const { stdout: probe } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', job.source],
    { signal },
  );
  if (!probe.toString().trim()) throw new Error('No audio track in this file');

  const peak = await measurePeak(job.source, signal);
  const inputGain = peak === null || peak < -80 ? 0 : clamp(-3 - peak, -30, 40);
  await ffmpeg(
    ['-v', 'error', '-i', job.source, '-map', '0:a:0', '-vn', '-af', `volume=${inputGain.toFixed(1)}dB`,
      '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', at('raw.wav')],
    { signal },
  );
  const raw = await readPcm(at('raw.wav'), signal);
  if (raw.length < SR * 0.05) throw new Error('The audio track is empty');
  const floorIn = noiseFloor(raw);
  patch({ raw: { duration: raw.length / SR, peaks: peaks(raw), floor: floorIn } });

  // 2. Denoise.
  stage('denoise');
  let clean = raw;
  let engine = 'none';
  let warning = null;
  if (settings.denoise !== 'off') {
    if (neural) {
      try {
        clean = await neuralDenoise(job, settings.denoise, signal);
        engine = 'neural';
      } catch (err) {
        if (signal?.aborted) throw err;
        warning = `DeepFilterNet failed, so the built-in denoiser was used instead. (${err.message})`;
      }
    }
    if (engine === 'none') {
      clean = await builtinDenoise(raw, settings.denoise, signal);
      engine = 'builtin';
    }
  }

  // 3. Trim: find the voice on a fully denoised copy (so detection works even
  //    when the output keeps some room tone), then cut the output to match.
  stage('trim');
  const wantsName = settings.name === 'spoken';
  let segments = [{ start: 0, end: clean.length }];
  let hasVoice = true;
  if (settings.trim !== 'off' || wantsName) {
    const strong = settings.denoise === 'studio' || settings.denoise === 'deep';
    const guide = strong ? clean : await builtinDenoise(raw, 'studio', signal);
    const regions = detectVoice(guide, raw);
    hasVoice = regions.length > 0;
    if (!hasVoice) warning ??= 'No voice was detected in this take.';
    segments = planSegments(regions, guide.length, settings.trim).map((s) => ({
      start: Math.min(s.start, clean.length),
      end: Math.min(s.end, clean.length),
    }));
  }
  const floorOut = noiseFloor(clean);
  const trimmed = cut(clean, segments);
  await writeWav(at('trimmed.wav'), trimmed);

  // 4. Master: tone-shape and compress, measure loudness, then apply one
  //    static gain to hit the target and catch stray peaks with a limiter.
  stage('master');
  const preset = POLISH[settings.polish];
  const shaped = await ffmpeg(
    ['-i', at('trimmed.wav'), '-af', [...preset.chain, 'ebur128=framelog=verbose'].join(','),
      '-c:a', 'pcm_f32le', at('shaped.wav')],
    { signal },
  );
  let measured = parseLoudness(shaped.stderr);
  if (measured === null || measured < -60) {
    // Too short or too quiet for a gated loudness reading; plain RMS is close enough.
    measured = rmsDb(await readPcm(at('shaped.wav'), signal));
  }
  const gain = measured < -80 ? 0 : clamp(preset.lufs - measured, -30, 40);
  const mastered = await ffmpeg(
    ['-i', at('shaped.wav'), '-af', `volume=${gain.toFixed(2)}dB,${LIMITER},ebur128=framelog=verbose`,
      '-ar', String(SR), '-c:a', 'pcm_s16le', at('master.wav')],
    { signal },
  );
  const lufs = parseLoudness(mastered.stderr);
  const master = await readPcm(at('master.wav'), signal);

  // 5. Name: listen to the finished audio and name the file after what is
  //    said. Skipped when there is no voice, where Whisper would invent words.
  let transcript = null;
  let spokenNames = [];
  if (wantsName && hasVoice) {
    stage('name');
    try {
      transcript = await transcribe(at('master.wav'), { signal, note });
      spokenNames = namesFromSpeech(transcript);
      if (!spokenNames.length) warning ??= 'No words were recognised, so the original name was kept.';
    } catch (err) {
      if (signal?.aborted) throw err;
      warning ??= `Could not transcribe this take, so the original name was kept. (${err.message})`;
    }
    signal?.throwIfAborted();
  }

  // 6. Export.
  stage('export');
  const ext = settings.format;
  const file = at(`final.${ext}`);
  if (ext === 'wav') {
    await copyFile(at('master.wav'), file);
  } else {
    await ffmpeg(['-v', 'error', '-i', at('master.wav'), '-c:a', 'libmp3lame', '-b:a', '192k', file], { signal });
  }

  await Promise.all(['trimmed.wav', 'shaped.wav', 'master.wav'].map((name) => rm(at(name), { force: true })));

  return {
    file,
    ext,
    engine,
    warning,
    bytes: (await stat(file)).size,
    duration: master.length / SR,
    peaks: peaks(master),
    segments: segments.map((s) => [s.start / SR, s.end / SR]),
    floorIn,
    floorOut,
    lufs: lufs !== null && lufs > -60 ? round1(lufs) : null,
    spokenNames,
    transcript,
    transcriptPartial: Boolean(transcript) && master.length / SR > LISTEN_SECONDS,
  };
}
