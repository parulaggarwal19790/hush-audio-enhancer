# hush

Drop in noisy videos or voice notes, get clean, trimmed, mastered audio back,
named after what is said in it.

Everything runs on your machine: no accounts, no uploads, no API keys.

- **Denoise** with a built-in spectral filter, or the neural
  [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) engine
- **Trim** dead air at the edges, and optionally long pauses
- **Master** with EQ, de-essing, compression and loudness normalisation
- **Name** each file after its opening words, transcribed locally with Whisper
- **Compare** raw and clean audio with one key while it plays

## Requirements

- [Node.js](https://nodejs.org) 22.2 or newer
- [ffmpeg](https://ffmpeg.org) on your `PATH`

| Platform | Install ffmpeg |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| Windows | `winget install ffmpeg` |

## Quick start

```sh
git clone https://github.com/<you>/hush.git
cd hush
npm install
npm run setup   # optional: installs the neural denoiser
npm start
```

Then open http://localhost:4747 (on macOS it opens by itself). Drop files
anywhere on the page, paste them, or click to browse. Finished audio is saved to
`output/` as each file completes, and can also be downloaded one at a time or
as a zip.

Any audio or video format ffmpeg can read works: `.mp4`, `.mov`, `.m4a`, `.mp3`,
`.wav`, `.ogg`, `.webm` and more.

## The neural denoiser (optional, recommended)

`npm run setup` downloads [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)
0.5.6, a single program of about 27 MB, from its official GitHub releases into
`bin/`. Restart the app and the header chip switches from "Built-in denoiser"
to "DeepFilterNet".

| Engine | Good at | Not good at |
| --- | --- | --- |
| Built-in | Steady noise: hiss, hum, fans, air-con, room tone | Noise that changes: traffic, keyboards, other voices |
| DeepFilterNet | Both of the above | — |

Prebuilt programs exist for macOS (Apple silicon and Intel), Linux (x64 and
arm64) and Windows (x64). On other platforms the built-in denoiser is used.

## What happens to a file

1. **Extract**: the audio track is pulled out as 48 kHz mono.
2. **Denoise**: Off / Light / Studio / Deep.
3. **Trim**: Off, *Edges* (dead air before the first word and after the last),
   or *Tight* (also shortens pauses longer than 0.45 s).
4. **Master**: *Clean* (levelled only), *Studio* (EQ, de-ess, compression,
   −16 LUFS) or *Radio* (warmer, brighter, −14 LUFS), with a −1.5 dB limiter.
5. **Name**: *Original* keeps the file's name; *Spoken* names it after its
   opening words (see below).
6. **Export**: MP3 (192 kbps) or WAV (48 kHz, 16-bit).

Each take shows the raw and clean waveforms. Click either one to listen from
that point, or press `A` to flip between them mid-playback. Change the settings
and any finished take offers a one-click re-run.

## Names from speech

With *Spoken* selected, each take is transcribed with Whisper, running locally,
and named after its opening phrase:

| Said | Saved as |
| --- | --- |
| "Hey, this is a quick voice note, I am testing the enhancer." | `hey-this-is-a-quick-voice-note.mp3` |
| "Don't forget to like and subscribe!" | `dont-forget-to-like-and-subscribe.mp3` |

- The name stops at the first natural pause, capped at 8 words.
- If that name is taken, a longer one is used (up to 14 words), then `-2`, `-3`.
- A take with no detectable voice keeps its original name.
- Only the first 30 seconds are transcribed, which is also what the take shows.
- The speech model (about 132 MB) downloads into `models/` from Hugging Face the
  first time a take is named. After that it works offline.

The default model understands English only. For another language, pick a
multilingual model and say which language to expect (it is not auto-detected):

```sh
HUSH_WHISPER_MODEL=Xenova/whisper-small HUSH_LANGUAGE=spanish npm start
```

`HUSH_WHISPER_MODEL=Xenova/whisper-small.en` is a larger, more accurate English
model, at a few times the download and processing time.

## Options

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4747` | Port to listen on |
| `HUSH_OUTPUT` | `./output` | Where finished audio is saved |
| `HUSH_WHISPER_MODEL` | `Xenova/whisper-base.en` | Speech model used for naming |
| `HUSH_LANGUAGE` | *(unset)* | Language to expect, for multilingual models |

`npm start -- --no-open` skips opening the browser. `npm run dev` restarts the
server whenever a file changes.

## What is downloaded, and where

Nothing leaves your machine except these one-time downloads:

| What | Size | From | Saved to |
| --- | --- | --- | --- |
| npm dependencies | ~480 MB | npm | `node_modules/` |
| Whisper base.en | ~132 MB | Hugging Face | `models/` |
| DeepFilterNet (optional) | ~27 MB | GitHub releases | `bin/` |

All three folders, and `output/`, are ignored by git.

## Troubleshooting

- **"ffmpeg: command not found"**: install ffmpeg (see
  [Requirements](#requirements)) and restart your terminal.
- **The header still says "Built-in denoiser" after setup**: restart the app;
  the denoiser is detected at start-up.
- **Naming is stuck on "Getting the speech model ready"**: the first run needs
  internet access to download the model. If the download is interrupted, the
  next take retries it.
- **Port 4747 is in use**: `PORT=5000 npm start`.

## Project layout

```
server.mjs          HTTP server, job queue, live updates
lib/pipeline.mjs    the six-stage chain
lib/denoise.mjs     built-in denoiser (STFT Wiener filter)
lib/transcribe.mjs  Whisper transcription and file naming
lib/audio.mjs       voice detection, cutting, waveform peaks
lib/zip.mjs         zip export
public/             the interface
scripts/setup.mjs   DeepFilterNet installer
```

## Credits

- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) by Hendrik
  Schröter et al. (MIT / Apache-2.0)
- [Whisper](https://github.com/openai/whisper) by OpenAI (MIT), via
  [transformers.js](https://github.com/huggingface/transformers.js) and the
  [Xenova/whisper-base.en](https://huggingface.co/Xenova/whisper-base.en) ONNX
  conversion
- [FFmpeg](https://ffmpeg.org) for decoding, filtering and encoding

## License

[MIT](LICENSE)
