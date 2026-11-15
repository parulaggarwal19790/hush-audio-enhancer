// Runs the built-in denoiser off the main thread so the server stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { spectralDenoise } from './denoise.mjs';

const out = spectralDenoise(workerData.pcm, workerData.strength);
parentPort.postMessage(out, [out.buffer]);
