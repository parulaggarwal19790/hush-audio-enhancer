const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const DEFAULTS = { denoise: 'studio', trim: 'edges', polish: 'studio', format: 'mp3', name: 'spoken' };
// The naming stage only appears for takes that are named after their words.
const stagesFor = (settings) => ['extract', 'denoise', 'trim', 'master', ...(settings?.name === 'spoken' ? ['name'] : []), 'export'];
const HINTS = {
  denoise: {
    off: 'Leave the background exactly as recorded.',
    light: 'Takes the edge off but keeps a little room tone.',
    studio: 'Removes the background and leaves just the voice.',
    deep: 'Hardest setting, for stubborn noise. Can thin out quiet words.',
  },
  trim: {
    off: 'Keep the full length.',
    edges: 'Cuts the dead air before the first word and after the last.',
    tight: 'Edges, plus long pauses between lines are shortened.',
  },
  polish: {
    clean: 'Evens out the volume. No colour added.',
    studio: 'EQ, de-ess and gentle compression. −16 LUFS.',
    radio: 'Warmer, brighter and louder. −14 LUFS.',
  },
  format: {
    mp3: '192 kbps. Small, plays anywhere.',
    wav: '48 kHz, 16-bit. Lossless.',
  },
  name: {
    original: "Keep each file's own name.",
    spoken: 'Named after the first words that are said.',
  },
};

const icon = (body, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  play: '<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6v10.8a.6.6 0 0 0 .92.5l8.3-5.4a.6.6 0 0 0 0-1L5.42 2.1a.6.6 0 0 0-.92.5z" fill="currentColor"/></svg>',
  pause: '<svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>',
  download: icon('<path d="M8 2v8.5m0 0L4.5 7M8 10.5 11.5 7M2.5 13.5h11"/>'),
  rerun: icon('<path d="M13.5 8a5.5 5.5 0 1 1-1.7-4"/><path d="M13.6 2.2v3.2h-3.2"/>'),
  folder: icon('<path d="M1.75 4.5a1 1 0 0 1 1-1h3.1l1.4 1.5h6a1 1 0 0 1 1 1v6.25a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>'),
  close: icon('<path d="m4 4 8 8m0-8-8 8"/>'),
};

const theme = getComputedStyle(document.documentElement);
const COLOR = Object.fromEntries(['lime', 'rust', 'text', 'muted'].map((name) => [name, theme.getPropertyValue(`--${name}`).trim()]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: settings just won't persist */
    }
  },
};

// ---- formatting --------------------------------------------------------------

function fmtTime(seconds) {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const signed = (value, digits = 0) => value.toFixed(digits).replace('-', '−');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
}

// ---- waveform drawing ---------------------------------------------------------

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

const easeOut = (t) => 1 - (1 - t) ** 3;

// One lane of a take. `isCut(fraction)` marks bars that were trimmed away,
// `progress` is the playhead (or null before anything has played), and `grow`
// animates the bars in from left to right.
function drawLane(canvas, peaks, { color, active, progress, isCut, grow = 1 }) {
  const { ctx, width, height } = sizeCanvas(canvas);
  if (!peaks || !width) return;

  const PITCH = 3;
  const bars = Math.floor(width / PITCH);
  const mid = height / 2;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i / bars) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j]);

    const fraction = (i + 0.5) / bars;
    const rise = easeOut(clamp(grow * 1.6 - fraction * 0.6, 0, 1));
    const amp = Math.max(0.6, peak ** 0.7 * (mid - 2) * rise);
    const cut = isCut?.(fraction);

    let alpha = active ? 0.92 : 0.4;
    if (progress !== null) alpha = fraction <= progress ? (active ? 1 : 0.55) : active ? 0.45 : 0.25;
    if (cut) alpha *= 0.75;
    if (peak < 0.004) alpha *= 0.45; // silence reads as a faint thread, not a solid rule

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = cut ? COLOR.rust : color;
    const x = i * PITCH + 1;
    ctx.beginPath();
    ctx.moveTo(x, mid - amp);
    ctx.lineTo(x, mid + amp);
    ctx.stroke();
  }

  if (progress !== null) {
    ctx.globalAlpha = active ? 1 : 0.4;
    ctx.fillStyle = COLOR.text;
    ctx.fillRect(clamp(progress * width, 0, width - 1.5), 0, 1.5, height);
  }
  ctx.globalAlpha = 1;
}

// ---- a take: one file moving through the chain ---------------------------------

const TAKE_HTML = `
  <button class="play" type="button" aria-label="Play">${ICONS.play}${ICONS.pause}</button>
  <div class="take-main">
    <div class="take-head"><span class="take-name"></span><span class="take-from"></span><span class="take-time"></span></div>
    <p class="said" hidden></p>
    <div class="lanes">
      <div class="lane lane-raw" data-lane="raw"><span class="lane-tag">RAW</span><canvas></canvas></div>
      <div class="lane lane-clean" data-lane="clean"><span class="lane-tag">CLEAN</span><canvas></canvas></div>
    </div>
    <div class="take-foot">
      <div class="status"></div>
      <div class="take-actions">
        <div class="ab" role="group" aria-label="Listen to">
          <button type="button" data-mode="raw">RAW</button><button type="button" data-mode="clean">CLEAN</button>
        </div>
        <button class="icon rerun" type="button" title="Process again with the current settings">${ICONS.rerun}<span class="rerun-label">Re-run with new settings</span></button>
        <a class="btn download" download title="Download">${ICONS.download}<span></span></a>
        <button class="icon reveal" type="button" title="Show the saved file">${ICONS.folder}</button>
        <button class="icon remove" type="button" title="Remove from the list (the saved file stays)">${ICONS.close}</button>
      </div>
    </div>
  </div>`;

const takes = new Map();
let current = null; // the take keyboard shortcuts act on

class Take {
  constructor(job) {
    this.job = job;
    this.mode = 'clean';
    this.players = {};
    this.playing = false;
    this.touched = false; // has the playhead been moved yet
    this.grow = 1;

    const root = (this.el = el('li', 'take'));
    root.innerHTML = TAKE_HTML;
    this.ui = {
      play: $('.play', root),
      name: $('.take-name', root),
      from: $('.take-from', root),
      said: $('.said', root),
      time: $('.take-time', root),
      status: $('.status', root),
      download: $('.download', root),
      raw: $('.lane-raw canvas', root),
      clean: $('.lane-clean canvas', root),
    };

    this.ui.play.addEventListener('click', () => this.toggle());
    $('.rerun', root).addEventListener('click', () => this.rerun());
    $('.reveal', root).addEventListener('click', () => fetch(`/api/jobs/${this.job.id}/reveal`, { method: 'POST' }));
    $('.remove', root).addEventListener('click', () => this.remove());
    for (const button of $$('.ab button', root)) {
      button.addEventListener('click', () => this.switchTo(button.dataset.mode));
    }
    for (const lane of $$('.lane', root)) this.bindScrub(lane);

    this.resizer = new ResizeObserver(() => this.draw());
    this.resizer.observe($('.lanes', root));
    this.render();
  }

  // -- state from the server --

  update(job) {
    const before = this.job.status;
    this.job = job;
    if ((before === 'done') !== (job.status === 'done')) this.resetPlayers();
    if (job.status === 'done' && before !== 'done') this.animateIn();
    this.render();
  }

  render() {
    const { job, ui } = this;
    this.el.dataset.status = job.status;
    this.el.dataset.mode = this.mode;
    this.el.classList.toggle('local', Boolean(job.local));
    // Once finished, a take goes by the name of the file it produced.
    const title = job.out?.name ?? job.name;
    const stem = (name) => name.replace(/\.[^.]+$/, '');
    ui.name.textContent = title;
    ui.name.title = title;
    ui.from.textContent = job.out && stem(title) !== stem(job.name) ? `from ${job.name}` : '';
    ui.said.hidden = !job.out?.transcript;
    ui.said.textContent = job.out?.transcript ? `“${job.out.transcript}${job.out.transcriptPartial ? ' …' : ''}”` : '';
    ui.said.title = job.out?.transcript ?? '';

    ui.time.replaceChildren();
    if (job.raw) ui.time.append(fmtTime(job.raw.duration));
    else ui.time.append(fmtBytes(job.size));
    if (job.out) ui.time.append(' → ', el('b', '', fmtTime(job.out.duration)));

    ui.status.replaceChildren(...this.statusNodes());

    if (job.out) {
      ui.download.href = `/api/jobs/${job.id}/final?download&v=${job.rev}`;
      $('span', ui.download).textContent = job.out.ext.toUpperCase();
    }
    this.refreshStale();
    this.draw();
  }

  statusNodes() {
    const { job } = this;
    if (job.status === 'uploading') return [`Uploading ${Math.round((job.progress ?? 0) * 100)}%`];
    if (job.status === 'queued') return ['Waiting in line'];
    if (job.status === 'error') return [el('p', 'problem', job.error || 'Something went wrong')];

    if (job.status === 'processing') {
      const stages = stagesFor(job.settings);
      const at = stages.indexOf(job.stage);
      const steps = el('ol', 'steps');
      stages.forEach((stage, i) => steps.append(el('li', i < at ? 'done' : i === at ? 'active' : '', stage)));
      return job.note ? [steps, el('p', 'note', job.note)] : [steps];
    }

    const { out, raw, settings } = job;
    const stats = el('div', 'stats');
    const stat = (label, ...value) => {
      const item = el('span', '', label);
      const strong = el('b');
      strong.append(...value);
      item.append(strong);
      stats.append(item);
    };
    if (out.engine !== 'none') {
      stat('Noise floor', `${signed(out.floorIn)} → `, el('span', 'good', signed(out.floorOut)), ' dB');
    }
    if (out.lufs !== null) stat('Loudness', `${signed(out.lufs, 1)} LUFS`);
    if (settings.trim !== 'off' && raw) stat('Trimmed', `${Math.max(0, raw.duration - out.duration).toFixed(1)} s`);
    stat('Size', fmtBytes(out.bytes));
    return job.warning ? [stats, el('p', 'caution', job.warning)] : [stats];
  }

  // Lights up the re-run button when the rack no longer matches this take.
  refreshStale() {
    const { job } = this;
    const differs = job.settings && Object.keys(DEFAULTS).some((key) => job.settings[key] !== settings[key]);
    this.el.classList.toggle('stale', job.status === 'done' && Boolean(differs));
  }

  animateIn() {
    if (reduceMotion) return;
    this.grow = 0;
    const start = performance.now();
    const step = (now) => {
      this.grow = Math.min(1, (now - start) / 900);
      this.draw();
      if (this.grow < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // -- timeline mapping between the raw recording and the trimmed result --

  toClean(t) {
    let elapsed = 0;
    for (const [start, end] of this.job.out.segments) {
      if (t < start) return elapsed;
      if (t <= end) return elapsed + (t - start);
      elapsed += end - start;
    }
    return elapsed;
  }

  toRaw(t) {
    let elapsed = 0;
    const { segments } = this.job.out;
    for (const [start, end] of segments) {
      if (t <= elapsed + (end - start)) return start + (t - elapsed);
      elapsed += end - start;
    }
    return segments.at(-1)?.[1] ?? t;
  }

  draw() {
    const { raw, out } = this.job;
    let rawAt = null;
    let cleanAt = null;
    if (out && this.touched) {
      const t = this.players[this.mode]?.currentTime ?? 0;
      rawAt = (this.mode === 'raw' ? t : this.toRaw(t)) / raw.duration;
      cleanAt = (this.mode === 'clean' ? t : this.toClean(t)) / out.duration;
    }
    drawLane(this.ui.raw, raw?.peaks, {
      color: COLOR.text,
      active: this.mode === 'raw' || !out,
      progress: rawAt,
      isCut: out && ((fraction) => !out.segments.some(([start, end]) => fraction * raw.duration >= start && fraction * raw.duration <= end)),
    });
    drawLane(this.ui.clean, out?.peaks, {
      color: COLOR.lime,
      active: this.mode === 'clean',
      progress: cleanAt,
      grow: this.grow,
    });
  }

  // -- playback --

  player(mode = this.mode) {
    if (!this.players[mode]) {
      const audio = new Audio(`/api/jobs/${this.job.id}/${mode === 'raw' ? 'raw' : 'final'}?v=${this.job.rev}`);
      audio.preload = 'auto';
      audio.addEventListener('ended', () => {
        if (mode === this.mode) this.setPlaying(false);
      });
      this.players[mode] = audio;
    }
    return this.players[mode];
  }

  resetPlayers() {
    for (const audio of Object.values(this.players)) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.players = {};
    this.touched = false;
    this.mode = 'clean';
    this.setPlaying(false);
  }

  setPlaying(playing) {
    this.playing = playing;
    this.el.classList.toggle('playing', playing);
    this.ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing) {
      const loop = () => {
        this.draw();
        if (this.playing) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } else {
      this.draw();
    }
  }

  play() {
    if (this.job.status !== 'done') return;
    if (current && current !== this) current.pause();
    setCurrent(this);
    const audio = this.player();
    if (audio.ended || audio.currentTime >= audio.duration - 0.03) audio.currentTime = 0;
    this.touched = true;
    audio.play().catch(() => this.setPlaying(false));
    this.setPlaying(true);
  }

  pause() {
    this.players[this.mode]?.pause();
    this.setPlaying(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  // Swap between raw and clean. With `carry`, playback continues from the same
  // moment in the other version.
  switchTo(mode, carry = true) {
    if (mode === this.mode || this.job.status !== 'done') return;
    const from = this.player();
    const position = from.currentTime;
    from.pause();
    this.mode = mode;
    this.el.dataset.mode = mode;
    const to = this.player();
    if (carry) to.currentTime = mode === 'raw' ? this.toRaw(position) : this.toClean(position);
    if (this.playing) to.play().catch(() => this.setPlaying(false));
    setCurrent(this);
    this.draw();
  }

  bindScrub(lane) {
    const mode = lane.dataset.lane;
    const seek = (event) => {
      const box = lane.getBoundingClientRect();
      const duration = mode === 'raw' ? this.job.raw.duration : this.job.out.duration;
      this.switchTo(mode, false);
      this.touched = true;
      this.player().currentTime = clamp((event.clientX - box.left) / box.width, 0, 1) * (duration - 0.05);
      this.draw();
    };
    lane.addEventListener('pointerdown', (event) => {
      if (this.job.status !== 'done' || event.button !== 0) return;
      lane.setPointerCapture(event.pointerId);
      seek(event);
      lane.onpointermove = seek;
      lane.onpointerup = lane.onpointercancel = () => {
        lane.onpointermove = lane.onpointerup = lane.onpointercancel = null;
        this.play();
      };
    });
  }

  // -- actions --

  async rerun() {
    const response = await fetch(`/api/jobs/${this.job.id}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    if (!response.ok) toast((await response.json().catch(() => ({}))).error || 'Could not re-run this take');
  }

  remove() {
    this.xhr?.abort();
    if (!this.job.local) fetch(`/api/jobs/${this.job.id}`, { method: 'DELETE' });
    dropTake(this.job.id);
  }

  destroy() {
    this.resetPlayers();
    this.resizer.disconnect();
    this.el.remove();
    if (current === this) current = null;
  }
}

function setCurrent(take) {
  current?.el.classList.remove('current');
  current = take;
  take.el.classList.add('current');
}

function upsertTake(job) {
  const existing = takes.get(job.id);
  if (existing) existing.update(job);
  else {
    const take = new Take(job);
    takes.set(job.id, take);
    $('#list').append(take.el);
  }
  refreshSummary();
  return takes.get(job.id);
}

function dropTake(id) {
  takes.get(id)?.destroy();
  takes.delete(id);
  refreshSummary();
}

function refreshSummary() {
  const all = [...takes.values()];
  const ready = all.filter((take) => take.job.status === 'done').length;
  document.body.classList.toggle('has-takes', all.length > 0);
  $('#takes').hidden = all.length === 0;
  $('#count').textContent = `${ready} of ${all.length} ready`;
  const button = $('#download-all');
  button.setAttribute('aria-disabled', String(ready === 0));
  $('span', button).textContent = ready > 1 ? `Download all ${ready}` : 'Download all';
}

// ---- settings rack --------------------------------------------------------------

const settings = { ...DEFAULTS, ...store.read('hush.settings', {}) };
const showHints = [];

for (const group of $$('#rack fieldset')) {
  const key = group.dataset.setting;
  const radios = $$('input', group);
  const chosen = radios.find((radio) => radio.value === settings[key]) ?? radios.find((radio) => radio.value === DEFAULTS[key]);
  chosen.checked = true;
  settings[key] = chosen.value;

  const hint = $('.hint', group);
  const showHint = () => {
    hint.textContent = HINTS[key][settings[key]];
  };
  showHints.push(showHint);
  showHint();
  group.addEventListener('change', (event) => {
    settings[key] = event.target.value;
    showHint();
    store.write('hush.settings', settings);
    for (const take of takes.values()) take.refreshStale();
  });
}

// ---- adding files ----------------------------------------------------------------

let accept = null; // file extensions the server can read; null until it tells us

function addFiles(files) {
  const skipped = [];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const ok = accept ? accept.has(ext) : /^(audio|video)\//.test(file.type);
    if (ok) upload(file);
    else skipped.push(file.name);
  }
  if (skipped.length === 1) toast(`Skipped ${skipped[0]}: not a video or audio file`);
  else if (skipped.length) toast(`Skipped ${skipped.length} files that aren't video or audio`);
}

let uploads = 0;

function upload(file) {
  // Position in the list: by time added, then by position within a batch.
  const order = Date.now() * 1000 + (uploads++ % 1000);
  const id = crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), 'u').slice(0, 12).padEnd(8, '0');
  const local = { id, name: file.name, size: file.size, order, status: 'uploading', progress: 0, local: true };
  const take = upsertTake(local);
  const fail = (message) => take.update({ ...local, status: 'error', error: message });

  const xhr = (take.xhr = new XMLHttpRequest());
  xhr.open('POST', `/api/jobs?${new URLSearchParams({ id, order, name: file.name, settings: JSON.stringify(settings) })}`);
  xhr.upload.onprogress = (event) => {
    if (take.job.status === 'uploading' && event.lengthComputable) {
      take.update({ ...take.job, progress: event.loaded / event.total });
    }
  };
  xhr.onload = () => {
    take.xhr = null;
    if (xhr.status !== 201) {
      let message = 'Upload failed';
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        /* keep the generic message */
      }
      return fail(message);
    }
    // Live updates may already have moved this take further along.
    if (take.job.status === 'uploading') take.update(JSON.parse(xhr.responseText));
    refreshSummary();
  };
  xhr.onerror = () => fail('Upload failed. Is the server still running?');
  xhr.send(file);
}

const drop = $('#drop');
const picker = $('#picker');
let flow = { speed: 34 };

drop.addEventListener('click', (event) => {
  if (event.target !== picker) picker.click();
});
drop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    picker.click();
  }
});
picker.addEventListener('change', () => {
  addFiles(picker.files);
  picker.value = '';
});

const carriesFiles = (event) => event.dataTransfer?.types.includes('Files');
let dragDepth = 0;
function setOver(over) {
  drop.classList.toggle('over', over);
  $('#drop-title').textContent = over ? 'Let go to clean them up' : 'Drop videos here';
  flow.speed = over ? 150 : 34;
}
window.addEventListener('dragenter', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  setOver(true);
});
window.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setOver(false);
});
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  setOver(false);
  addFiles(event.dataTransfer.files);
});
document.addEventListener('paste', (event) => {
  if (event.clipboardData?.files.length) addFiles(event.clipboardData.files);
});

// ---- page-level actions -------------------------------------------------------------

$('#open-output').addEventListener('click', () => fetch('/api/reveal', { method: 'POST' }));
$('#clear').addEventListener('click', () => {
  for (const take of [...takes.values()]) take.xhr?.abort();
  fetch('/api/jobs', { method: 'DELETE' });
  for (const id of [...takes.keys()]) dropTake(id);
});
$('#notice-close').addEventListener('click', () => {
  $('#notice').hidden = true;
  store.write('hush.notice-dismissed', true);
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const take = current ?? [...takes.values()].find((candidate) => candidate.job.status === 'done');
  if (!take) return;
  if (event.code === 'Space') {
    // Focused buttons and links already respond to Space themselves.
    if (event.target.closest('button, a, input, [role="button"]')) return;
    event.preventDefault();
    take.toggle();
  } else if (event.key.toLowerCase() === 'a') {
    take.switchTo(take.mode === 'raw' ? 'clean' : 'raw');
  }
});

// ---- the hero animation: noise flows in from the left, a clean voice leaves on the right ----

function startFlow(canvas) {
  const ctx = canvas.getContext('2d');
  const state = { speed: 34 };
  let width = 0;
  let height = 0;
  let travelled = 0;
  let last = performance.now();

  const hash = (n) => {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  // A made-up voice: phrases with pauses between them, syllables inside each phrase.
  const voice = (i) => {
    const phrase = Math.max(0, Math.sin(i * 0.052) + 0.55 * Math.sin(i * 0.021 + 1.7) + 0.4);
    const syllable = 0.5 + 0.5 * Math.sin(i * 0.46 + 2.2 * Math.sin(i * 0.09));
    return Math.min(1, phrase * (0.25 + 0.75 * syllable) * (0.7 + 0.3 * hash(i)));
  };

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    travelled += dt * state.speed;

    const PITCH = 7;
    const mid = height / 2;
    const gate = width / 2;
    const shift = Math.floor(travelled / PITCH);
    const flicker = Math.floor(now / 70);

    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (let slot = -1, x = (travelled % PITCH) - PITCH; x < width + PITCH; slot++, x += PITCH) {
      const index = slot - shift;
      const noisy = x < gate;
      // the hiss thins out as it approaches the gate, and never makes it through
      const hiss = noisy ? Math.min(1, (gate - x) / 120) * (4 + 15 * hash(index * 3.3 + flicker)) : 0;
      const amp = Math.max(1, voice(index) * (mid - 20) * (noisy ? 0.8 : 1) + hiss);
      ctx.globalAlpha = noisy ? 0.5 : 0.9;
      ctx.strokeStyle = noisy ? COLOR.rust : COLOR.lime;
      ctx.beginPath();
      ctx.moveTo(x, mid - amp);
      ctx.lineTo(x, mid + amp);
      ctx.stroke();
    }

    const line = ctx.createLinearGradient(0, 0, 0, height);
    line.addColorStop(0, 'rgba(214, 255, 63, 0)');
    line.addColorStop(0.18, COLOR.lime);
    line.addColorStop(0.82, COLOR.lime);
    line.addColorStop(1, 'rgba(214, 255, 63, 0)');
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = line;
    ctx.fillRect(gate - 0.75, 0, 1.5, height);
    ctx.globalAlpha = 1;

    if (!reduceMotion) requestAnimationFrame(frame);
  }

  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduceMotion) frame(performance.now());
  }).observe(canvas);

  if (!reduceMotion) requestAnimationFrame(frame);
  return state;
}

flow = startFlow($('#flow'));

// ---- live connection to the server ---------------------------------------------------

const events = new EventSource('/api/events');
events.addEventListener('sync', (event) => {
  const jobs = JSON.parse(event.data).sort((a, b) => a.order - b.order);
  const known = new Set(jobs.map((job) => job.id));
  for (const [id, take] of takes) {
    if (!known.has(id) && !take.job.local) dropTake(id);
  }
  jobs.forEach(upsertTake);
});
events.addEventListener('job', (event) => upsertTake(JSON.parse(event.data)));
events.addEventListener('remove', (event) => dropTake(JSON.parse(event.data).id));

fetch('/api/info')
  .then((response) => response.json())
  .then((info) => {
    accept = new Set(info.accept);
    const chip = $('#engine');
    chip.dataset.engine = info.engine;
    $('span', chip).textContent = info.engine === 'neural' ? 'DeepFilterNet' : 'Built-in denoiser';
    chip.hidden = false;
    $('#output-label').textContent = info.outputLabel;
    $('#notice').hidden = info.engine === 'neural' || store.read('hush.notice-dismissed', false);
    if (!info.speech) {
      HINTS.name.spoken = 'Needs the speech library first: run npm install, then restart.';
      showHints.forEach((show) => show());
    }
  })
  .catch(() => toast('Lost contact with the server. Is it still running?'));
