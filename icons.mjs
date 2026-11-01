// Makes the PNG and ICO icons from static/favicon.svg: favicon.ico, favicon-48.png, icon-192.png, apple-touch-icon.png.
//   node icons.mjs
// Search engines and phones want real PNG/ICO files next to the SVG. It draws the SVG on a tiny web page and
// photographs it with headless Edge or Chrome, so it needs one of them installed. Run it only when the SVG
// changes, then commit the files. The site build never runs a browser; it only copies the finished files.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(ROOT, 'static', 'favicon.svg'), 'utf8');

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('No Edge or Chrome found. Install one, or set BROWSER_PATH to its executable.');
  process.exit(1);
}

// Screenshots at the requested size. Browsers refuse very small windows, so shoot big and read the top-left.
const work = mkdtempSync(join(tmpdir(), 'icons-'));
function render(name, size, markup) {
  const html = join(work, `${name}.html`);
  const png = join(work, `${name}.png`);
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>*{margin:0}html,body{width:${size}px;height:${size}px;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
  );
  const run = spawnSync(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${png}`, pathToFileURL(html).href],
    { stdio: 'ignore', timeout: 60000 },
  );
  if (run.status !== 0 || !existsSync(png)) return null;
  return readFileSync(png);
}

const dims = (buf) => (buf ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);
// The rounded corners suit browser tabs. Phones round the corners themselves, so the home-screen icon is a full square.
const square = svg.replace(/rx="\d+"/, 'rx="0"');

const jobs = [
  ['favicon-48.png', 48, svg],
  ['icon-192.png', 192, svg],
  ['apple-touch-icon.png', 180, square],
];

let failed = 0;
const made = {};
for (const [file, size, markup] of jobs) {
  const buf = render(file.replace('.png', ''), size, markup);
  const [w, h] = dims(buf) || [0, 0];
  if (!buf || w !== size || h !== size) {
    failed++;
    console.error(`  FAILED  ${file} (got ${w}x${h}, wanted ${size}x${size})`);
    continue;
  }
  writeFileSync(join(ROOT, 'static', file), buf);
  made[file] = buf;
  console.log(`  made  static/${file}`);
}

// favicon.ico: a one-image ICO that holds the 48x48 PNG (every current browser reads PNG inside ICO).
if (made['favicon-48.png']) {
  const png = made['favicon-48.png'];
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(48, 6); // width
  header.writeUInt8(48, 7); // height
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14); // image size
  header.writeUInt32LE(22, 18); // image offset
  writeFileSync(join(ROOT, 'static', 'favicon.ico'), Buffer.concat([header, png]));
  console.log('  made  static/favicon.ico');
}

rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
