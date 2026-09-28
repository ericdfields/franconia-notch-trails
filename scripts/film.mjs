// Renders a scene from scripts/films/ into a movie, one exact frame at a time.
//
//   npm run dev                                        (in another terminal)
//   npm run film -- franconia-ridge-traverse              4K, 30 fps → renders/franconia-ridge-traverse.mp4
//   npm run film -- franconia-ridge-traverse --draft      1080p, 15 fps, fast, for checking timing
//   npm run film -- franconia-ridge-traverse --still 12.5 one PNG at 12.5 seconds
//
// Options: --fps N, --no-captions, --out path.mp4
// Env: APP_URL (default http://127.0.0.1:5180/), CHROME_PATH (default: macOS Chrome)
//
// The page is laid out at 1920×1080 CSS pixels and rendered at 2× for 4K, so labels and
// captions come out at the same size relative to the frame in every resolution.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const sceneName = args.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a)) ?? 'franconia-ridge-traverse';
const draft = flag('draft');
const still = option('still', null);
const fps = Number(option('fps', draft ? 15 : 30));
const scale = draft ? 1 : 2;
const out = path.resolve(option('out', path.join(ROOT, 'renders', `${sceneName}${draft ? '-draft' : ''}.mp4`)));
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5180/';
const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const scene = await import(path.join(ROOT, 'scripts', 'films', `${sceneName}.mjs`));

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: scale });
const url = new URL(APP_URL);
url.searchParams.set('film', '');
await page.goto(url.href, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__film?.ready, { timeout: 60000 });
await page.evaluate(() => document.fonts.ready);

// Scenes get a helper for talking to the page, and build their timeline from it
const film = (method, ...params) => page.evaluate((m, p) => window.__film[m](...p), method, params);
const timeline = await scene.setup({ film, captions: !flag('no-captions') });
const frames = Math.round(timeline.duration * fps);

const renderFrame = async (t) => {
  await page.evaluate((s) => window.__film.frame(s), timeline.at(t));
  return page.screenshot({ type: still ? 'png' : 'jpeg', quality: still ? undefined : 95, optimizeForSpeed: true });
};

fs.mkdirSync(path.dirname(out), { recursive: true });

if (still) {
  const file = out.replace(/\.mp4$/, `-${still}s.png`);
  fs.writeFileSync(file, await renderFrame(Number(still)));
  console.log(`wrote ${path.relative(ROOT, file)}`);
  await browser.close();
  process.exit(0);
}

console.log(`${sceneName}: ${timeline.duration}s, ${frames} frames at ${fps} fps, ${1920 * scale}×${1080 * scale}`);
// Frames stream straight into ffmpeg, so nothing piles up on disk
const ffmpeg = spawn(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    // JPEG frames are full-range; convert to the standard video range so every player agrees on the colors
    '-vf', 'scale=in_range=full:out_range=tv', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'slow', '-crf', draft ? '23' : '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    out,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));

const started = Date.now();
for (let i = 0; i < frames; i++) {
  const buf = await renderFrame(i / fps);
  if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  if (i % fps === 0 || i === frames - 1) {
    const secs = (Date.now() - started) / 1000;
    const eta = (secs / (i + 1)) * (frames - i - 1);
    process.stdout.write(`\r  frame ${i + 1}/${frames}  (${Math.round(secs)}s elapsed, ~${Math.round(eta)}s left)   `);
  }
}
ffmpeg.stdin.end();
await done;
await browser.close();
console.log(`\nwrote ${path.relative(ROOT, out)}`);
