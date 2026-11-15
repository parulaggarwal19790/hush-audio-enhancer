// Downloads the DeepFilterNet denoiser binary for this machine into ./bin.
// Run once with `npm run setup`. It is optional: without it the app uses its
// built-in denoiser. The binary comes from the project's official GitHub
// releases: https://github.com/Rikorose/DeepFilterNet/releases
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const VERSION = '0.5.6';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc.exe',
};

export const denoiserPath = join(ROOT, 'bin', process.platform === 'win32' ? 'deep-filter.exe' : 'deep-filter');

export async function hasDenoiser() {
  try {
    return (await stat(denoiserPath)).size > 1_000_000;
  } catch {
    return false;
  }
}

export async function installDenoiser(log = console.log) {
  if (await hasDenoiser()) return true;

  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    log(`No prebuilt DeepFilterNet binary for ${process.platform}-${process.arch}; falling back to the ffmpeg denoiser.`);
    return false;
  }

  const url = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${VERSION}/deep-filter-${VERSION}-${target}`;
  log(`Downloading DeepFilterNet ${VERSION} (${target})…`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

  await mkdir(dirname(denoiserPath), { recursive: true });
  const partial = `${denoiserPath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    await chmod(partial, 0o755);
    await rename(partial, denoiserPath);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }

  log('DeepFilterNet installed.');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installDenoiser().catch((err) => {
    console.error(`Could not install DeepFilterNet: ${err.message}`);
    process.exit(1);
  });
}
