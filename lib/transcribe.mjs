// Speech-to-text for naming files after what is said in them. Runs Whisper
// locally through transformers.js; the model is downloaded once into ./models.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpeg } from './audio.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// English-only by default. For other languages use a multilingual model and
// say which language to expect (this library cannot detect it), for example
//   HUSH_WHISPER_MODEL=Xenova/whisper-small HUSH_LANGUAGE=spanish
const MODEL = process.env.HUSH_WHISPER_MODEL || 'Xenova/whisper-base.en';
const LANGUAGE = process.env.HUSH_LANGUAGE || null;

// Whisper hears audio in 30-second windows; one window is plenty for a name.
export const LISTEN_SECONDS = 30;
const SPEECH_RATE = 16000;

let loading = null;
let queue = Promise.resolve();
const watchers = new Set(); // callbacks told about model download progress

function loadModel() {
  loading ??= (async () => {
    let library;
    try {
      library = await import('@huggingface/transformers');
    } catch {
      throw new Error('the speech library is not installed: run "npm install"');
    }
    library.env.cacheDir = join(ROOT, 'models');
    return library.pipeline('automatic-speech-recognition', MODEL, {
      // Whisper's encoder loses accuracy when quantised; its decoder does not.
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
      progress_callback: (info) => {
        if (info.status !== 'progress_total') return;
        for (const tell of watchers) tell(info.progress);
      },
    });
  })();
  loading.catch(() => {
    loading = null; // e.g. offline on first run: try again next time
  });
  return loading;
}

// Transcribes the first LISTEN_SECONDS of an audio file. `note(text)` receives
// a short status line while the model is being fetched or loaded.
export async function transcribe(file, { signal, note = () => {} } = {}) {
  const { stdout } = await ffmpeg(
    ['-v', 'error', '-i', file, '-t', String(LISTEN_SECONDS), '-f', 'f32le', '-ac', '1', '-ar', String(SPEECH_RATE), '-'],
    { signal },
  );
  const samples = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.length & ~3)));

  // First run downloads the model; after that this is a quick load from disk.
  const watcher = (percent) => note(`Getting the speech model ready ${Math.floor(percent)}%`);
  watchers.add(watcher);
  let recognise;
  try {
    recognise = await loadModel();
  } finally {
    watchers.delete(watcher);
    note(null);
  }

  // One take at a time: a single run already uses every core.
  const result = queue.then(() => recognise(samples, LANGUAGE ? { language: LANGUAGE, task: 'transcribe' } : {}));
  queue = result.catch(() => {});
  return (await result).text.replace(/\s+/g, ' ').trim();
}

const isWord = (token) => /^[\p{L}\p{N}]/u.test(token);

function joinWords(tokens, maxWords, maxLength, stopAtPause) {
  const picked = [];
  for (const token of tokens) {
    if (!isWord(token)) {
      if (stopAtPause && picked.length >= 3) break;
      continue;
    }
    if (picked.length === maxWords || [...picked, token].join('-').length > maxLength) break;
    picked.push(token);
  }
  return picked.join('-');
}

// Candidate file names for a transcript, best first:
//   "Hey, this is a quick voice note, I am testing the enhancer."
//   -> ["hey-this-is-a-quick-voice-note", "hey-this-is-a-quick-voice-note-i-am-testing-the-enhancer"]
// The first stops at a natural pause so it reads as a whole phrase. The longer
// one is there for when two takes open with the same words.
// Lowercase words joined by hyphens are safe in any tool, on any file system.
export function namesFromSpeech(text) {
  const tokens =
    text
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // Whisper's own asides: [BLANK_AUDIO], (music)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/['’]/g, '') // don't -> dont
      // words, or punctuation that marks a pause ("3.5" is not one)
      .match(/[\p{L}\p{N}]+|[.!?…,;:—–]+(?=\s|$)|[。！？、，]+/gu) ?? [];

  const names = [...new Set([joinWords(tokens, 8, 60, true), joinWords(tokens, 14, 90, false)])].filter(Boolean);
  if (names.length) return names;
  // Scripts written without spaces arrive as one long "word".
  const first = tokens.find(isWord);
  return first ? [Array.from(first).slice(0, 60).join('')] : [];
}
