// Built-in denoiser: learns the noise spectrum from the quietest moments of the
// recording, then applies a decision-directed Wiener filter in the STFT domain.
// Strong on steady noise (hiss, hum, fans, room tone). It cannot remove sounds
// that change over time (traffic, keyboards, other voices): that is what the
// optional DeepFilterNet engine is for.

const N = 2048;
const HOP = N / 4;
const BINS = N / 2 + 1;
const PAD = N - HOP; // leading zeros, so the very first sample sits under four windows

// over: how much louder than its average the noise is assumed to be (higher
// removes more, at the cost of quiet speech detail). floorDb: the most any
// frequency is ever turned down.
const STRENGTH = {
  light: { over: 1.0, floorDb: -12 },
  studio: { over: 1.4, floorDb: -36 },
  deep: { over: 2.6, floorDb: -60 },
};

function createFft(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  };
}

const fft = createFft(N);
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
// Hann analysis x Hann synthesis at 75% overlap sums to a constant 1.5.
const OLA_GAIN = 1.5;

export function spectralDenoise(pcm, strength = 'studio') {
  const { over, floorDb } = STRENGTH[strength] ?? STRENGTH.studio;
  const minGain = 10 ** (floorDb / 20);
  const frames = Math.ceil((pcm.length + N) / HOP);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // Loads windowed frame t into re/im and returns its level in dB.
  const load = (t) => {
    const offset = t * HOP - PAD;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const p = offset + i;
      const v = p >= 0 && p < pcm.length ? pcm[p] / 32768 : 0;
      sum += v * v;
      re[i] = v * hann[i];
      im[i] = 0;
    }
    return 10 * Math.log10(sum / N + 1e-12);
  };

  // Pass 1: average the power spectrum of the quietest frames (ignoring
  // digital silence) into the noise profile.
  const level = new Float64Array(frames);
  for (let t = 0; t < frames; t++) level[t] = load(t);
  const audible = Array.from(level).filter((db) => db > -85).sort((a, b) => a - b);
  if (audible.length < 8) return pcm;
  const quietCeiling = Math.max(audible[Math.floor(audible.length * 0.1)] + 3, audible[7]);

  const noise = new Float64Array(BINS);
  let quiet = 0;
  for (let t = 0; t < frames; t++) {
    if (level[t] <= -85 || level[t] > quietCeiling) continue;
    load(t);
    fft(re, im, false);
    for (let k = 0; k < BINS; k++) noise[k] += re[k] * re[k] + im[k] * im[k];
    quiet++;
  }
  for (let k = 0; k < BINS; k++) noise[k] = (noise[k] / quiet) * over + 1e-12;

  // Pass 2: per-bin Wiener gain from a smoothed ("decision-directed") estimate
  // of the speech-to-noise ratio, which keeps the residual free of the chirpy
  // artefacts plain spectral subtraction leaves behind.
  const ALPHA = 0.98;
  const speech = new Float64Array(BINS); // previous frame's clean-speech power estimate
  const gain = new Float64Array(BINS);
  const smooth = new Float64Array(BINS);
  const overlap = new Float64Array(N);
  const out = new Int16Array(pcm.length);

  for (let t = 0; t < frames; t++) {
    load(t);
    fft(re, im, false);
    for (let k = 0; k < BINS; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      const posterior = power / noise[k];
      const prior = (ALPHA * speech[k]) / noise[k] + (1 - ALPHA) * Math.max(posterior - 1, 0);
      gain[k] = prior / (1 + prior);
      speech[k] = gain[k] * gain[k] * power;
    }
    for (let k = 0; k < BINS; k++) {
      const lo = gain[k > 0 ? k - 1 : k];
      const hi = gain[k < BINS - 1 ? k + 1 : k];
      smooth[k] = Math.max(minGain, 0.25 * lo + 0.5 * gain[k] + 0.25 * hi);
    }
    for (let k = 0; k < BINS; k++) {
      re[k] *= smooth[k];
      im[k] *= smooth[k];
      if (k > 0 && k < BINS - 1) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) overlap[i] += re[i] * hann[i];

    // The first HOP samples have now received all four overlapping windows.
    const base = t * HOP - PAD;
    for (let i = 0; i < HOP; i++) {
      const p = base + i;
      if (p < 0 || p >= out.length) continue;
      const v = Math.round((overlap[i] / OLA_GAIN) * 32768);
      out[p] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    overlap.copyWithin(0, HOP);
    overlap.fill(0, N - HOP);
  }
  return out;
}
