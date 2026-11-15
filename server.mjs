#!/usr/bin/env node
// Hush: local web app that turns noisy videos / voice notes into clean audio.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { run } from './lib/audio.mjs';
import { DEFAULTS, STAGES, normalizeSettings, probeNeural, processJob } from './lib/pipeline.mjs';
import { zip } from './lib/zip.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const WORK = join(ROOT, '.work');
const OUTPUT = resolve(process.env.HUSH_OUTPUT || join(ROOT, 'output'));
const PORT = Number(process.env.PORT) || 4747;
const CONCURRENCY = Math.min(3, Math.max(1, Math.floor(os.availableParallelism() / 4)));
const MAX_UPLOAD = 4 * 1024 ** 3;

const ACCEPT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp', '.mts',
  '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aiff', '.aif', '.caf', '.amr', '.wma',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// ---- jobs -------------------------------------------------------------------

const jobs = new Map();
const queue = [];
let active = 0;
let engine = 'builtin';

const publicJob = ({ id, name, size, order, rev, status, stage, note, error, warning, settings, raw, out }) => ({
  id, name, size, order, rev, status, stage, note, error, warning, settings, raw, out,
});

function enqueue(job) {
  Object.assign(job, { status: 'queued', stage: null, note: null, error: null, warning: null, out: null });
  queue.push(job);
  publish(job);
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    execute(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function execute(job) {
  job.controller = new AbortController();
  const { signal } = job.controller;
  job.status = 'processing';
  publish(job);
  try {
    const { file, ...result } = await processJob(job, {
      signal,
      stage: (name) => {
        job.stage = name;
        job.note = null;
        publish(job);
      },
      note: (text) => {
        if (job.note === text) return;
        job.note = text;
        publish(job);
      },
      patch: (fields) => {
        Object.assign(job, fields);
        publish(job);
      },
    });
    // A re-run replaces this take's previous file rather than piling up copies.
    if (job.outputPath) await rm(job.outputPath, { force: true });
    signal.throwIfAborted();
    const { warning, spokenNames, ...stats } = result;
    job.outputPath = await saveOutput(file, spokenNames.length ? spokenNames : [job.base], stats.ext);
    await rm(file, { force: true });
    job.warning = warning;
    job.out = { ...stats, name: basename(job.outputPath) };
    job.status = 'done';
    job.rev++;
  } catch (err) {
    if (signal.aborted) return; // removed by the user mid-flight
    job.status = 'error';
    job.error = err.message;
  }
  job.stage = null;
  job.note = null;
  publish(job);
}

// Copies into the output folder without ever overwriting a file that is
// already there. Tries each candidate name in turn, then falls back to
// numbering the first: clip.mp3, clip-2.mp3, clip-3.mp3, ...
function* outputNames(bases) {
  yield* bases;
  for (let n = 2; ; n++) yield `${bases[0]}-${n}`;
}

async function saveOutput(file, bases, ext) {
  for (const base of outputNames(bases)) {
    const target = join(OUTPUT, `${base}.${ext}`);
    try {
      await copyFile(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function removeJob(job) {
  jobs.delete(job.id);
  const queued = queue.indexOf(job);
  if (queued >= 0) queue.splice(queued, 1);
  job.controller?.abort();
  broadcast('remove', { id: job.id });
  await rm(job.dir, { recursive: true, force: true });
}

// ---- live updates (server-sent events) --------------------------------------

const clients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(message);
}

const publish = (job) => jobs.has(job.id) && broadcast('job', publicJob(job));

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`event: sync\ndata: ${JSON.stringify([...jobs.values()].map(publicJob))}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
setInterval(() => {
  for (const client of clients) client.write(': keep-alive\n\n');
}, 25000).unref();

// ---- http helpers -----------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

async function sendFile(req, res, file, { download } = {}) {
  let size;
  try {
    ({ size } = await stat(file));
  } catch {
    return json(res, 404, { error: 'File not found' });
  }
  const headers = {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

// The server only listens on loopback; this also rejects other websites trying
// to reach it through the browser (DNS rebinding, cross-site form posts).
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
function isLocalRequest(req) {
  if (!LOCAL.has((req.headers.host || '').replace(/:\d+$/, ''))) return false;
  if (!req.headers.origin) return true;
  try {
    return LOCAL.has(new URL(req.headers.origin).hostname);
  } catch {
    return false;
  }
}

function cleanBase(name) {
  const base = basename(name.replace(/\\/g, '/'), extname(name))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120);
  return base || 'voice-note';
}

function reveal(path, select) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', select ? ['-R', path] : [path]]
    : process.platform === 'win32' ? ['explorer', [select ? `/select,${path}` : path]]
    : ['xdg-open', [select ? dirname(path) : path]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ---- routes -----------------------------------------------------------------

async function createJob(req, res, url) {
  const hinted = Number(url.searchParams.get('order'));
  const order = hinted > 0 ? hinted : Date.now() * 1000;
  const name = (url.searchParams.get('name') || 'untitled').slice(0, 300);
  const ext = extname(name).toLowerCase();
  if (!ACCEPT.has(ext)) return json(res, 415, { error: `Can't read ${ext || 'this kind of'} file` });
  if (Number(req.headers['content-length']) > MAX_UPLOAD) return json(res, 413, { error: 'File is larger than 4 GB' });

  const requested = url.searchParams.get('id') || '';
  const id = /^[a-z0-9]{8,24}$/.test(requested) ? requested : randomBytes(6).toString('hex');
  if (jobs.has(id)) return json(res, 409, { error: 'Duplicate upload' });

  let settings;
  try {
    settings = normalizeSettings(JSON.parse(url.searchParams.get('settings') || '{}'));
  } catch {
    settings = { ...DEFAULTS };
  }

  const dir = join(WORK, id);
  const source = join(dir, `source${ext}`);
  await mkdir(dir, { recursive: true });
  try {
    await pipeline(req, createWriteStream(source));
  } catch {
    await rm(dir, { recursive: true, force: true }); // upload was cancelled
    return res.destroy();
  }

  const { size } = await stat(source);
  if (!size) {
    await rm(dir, { recursive: true, force: true });
    return json(res, 400, { error: 'File is empty' });
  }

  const job = { id, name, base: cleanBase(name), size, order, rev: 0, settings, dir, source, raw: null };
  jobs.set(id, job);
  enqueue(job);
  json(res, 201, publicJob(job));
}

async function route(req, res) {
  if (!isLocalRequest(req)) return json(res, 403, { error: 'Forbidden' });

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/info' && method === 'GET') {
    return json(res, 200, {
      engine,
      speech: existsSync(join(ROOT, 'node_modules/@huggingface/transformers/package.json')),
      output: OUTPUT,
      outputLabel: OUTPUT.startsWith(os.homedir()) ? `~${OUTPUT.slice(os.homedir().length)}` : OUTPUT,
      defaults: DEFAULTS,
      stages: STAGES,
      accept: [...ACCEPT],
    });
  }
  if (path === '/api/events' && method === 'GET') return openEvents(req, res);
  if (path === '/api/jobs' && method === 'POST') return createJob(req, res, url);

  if (path === '/api/jobs' && method === 'DELETE') {
    await Promise.all([...jobs.values()].map(removeJob));
    return json(res, 200, { ok: true });
  }

  if (path === '/api/zip' && method === 'GET') {
    const done = [...jobs.values()].filter((job) => job.status === 'done');
    if (!done.length) return json(res, 404, { error: 'Nothing to download yet' });
    const entries = await Promise.all(
      done.map(async (job) => ({ name: job.out.name, data: await readFile(job.outputPath) })),
    );
    const archive = zip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': archive.length,
      'Content-Disposition': 'attachment; filename="hush-takes.zip"',
      'Cache-Control': 'no-store',
    });
    return res.end(archive);
  }

  if (path === '/api/reveal' && method === 'POST') {
    reveal(OUTPUT, false);
    return json(res, 200, { ok: true });
  }

  const match = /^\/api\/jobs\/([a-z0-9]+)(?:\/([a-z]+))?$/.exec(path);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return json(res, 404, { error: 'Take not found' });
    const action = match[2];

    if (!action && method === 'DELETE') {
      await removeJob(job);
      return json(res, 200, { ok: true });
    }
    if (action === 'rerun' && method === 'POST') {
      if (job.status !== 'done' && job.status !== 'error') return json(res, 409, { error: 'Still processing' });
      job.settings = normalizeSettings((await readJson(req)).settings);
      enqueue(job);
      return json(res, 200, publicJob(job));
    }
    if (action === 'reveal' && method === 'POST') {
      if (job.outputPath) reveal(job.outputPath, true);
      return json(res, 200, { ok: true });
    }
    if (action === 'raw' && (method === 'GET' || method === 'HEAD')) {
      return sendFile(req, res, join(job.dir, 'raw.wav'));
    }
    if (action === 'final' && (method === 'GET' || method === 'HEAD')) {
      if (!job.outputPath) return json(res, 404, { error: 'Not ready yet' });
      return sendFile(req, res, job.outputPath, { download: url.searchParams.has('download') && job.out.name });
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    const file = resolve(PUBLIC, `.${path === '/' ? '/index.html' : path}`);
    if (file.startsWith(PUBLIC + sep)) return sendFile(req, res, file);
  }
  json(res, 404, { error: 'Not found' });
}

// ---- start ------------------------------------------------------------------

try {
  await run('ffmpeg', ['-version']);
  await run('ffprobe', ['-version']);
} catch {
  console.error('Hush needs ffmpeg and ffprobe on your PATH. On macOS: brew install ffmpeg');
  process.exit(1);
}

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await mkdir(OUTPUT, { recursive: true });
if (await probeNeural()) engine = 'neural';

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: err.message });
  });
});

let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) return server.listen(++port, '127.0.0.1');
  throw err;
});
server.on('listening', () => {
  const address = `http://localhost:${port}`;
  console.log(`\n  hush is listening at ${address}`);
  console.log(`  denoiser: ${engine === 'neural' ? 'DeepFilterNet (neural)' : 'built-in spectral  (run "npm run setup" for the neural engine)'}`);
  console.log(`  saving to: ${OUTPUT}\n`);
  if (!process.argv.includes('--no-open') && process.platform === 'darwin') {
    spawn('open', [address], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
server.listen(port, '127.0.0.1');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const job of jobs.values()) job.controller?.abort();
    await rm(WORK, { recursive: true, force: true });
    process.exit(0);
  });
}
