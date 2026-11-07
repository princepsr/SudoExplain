// Makes the link-preview card for every published post: static/og/<slug>.png (1200x630),
// and the home page card static/og.png from the tagline in site.config.json.
//   node og-images.mjs
// It draws each card as a small web page and photographs it with headless Edge or Chrome, so it needs one
// of them installed on your computer. Run it after writing or retitling a post, then commit the PNGs.
// The site build never runs a browser; it only uses the finished images.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));

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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Just the front matter fields the card needs.
function readPost(file) {
  const text = readFileSync(join(ROOT, 'content', 'posts', file), 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    // Drop the quote marks that wrap a value such as title: "Slow SQL query".
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!meta.title || meta.draft === 'true') return null;
  const tags = (meta.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => (t === t.toUpperCase() ? t : t.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())));
  return { slug: file.replace(/\.md$/, ''), title: meta.title, tags };
}

const card = (post) => {
  const n = post.title.length;
  const size = n <= 38 ? 76 : n <= 56 ? 64 : 54;
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#121214;color:#ece9e1;font-family:Georgia,'Palatino Linotype',serif;border-top:10px solid #ff8a5c;padding:70px 80px 56px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:26px;font:700 40px 'Segoe UI',system-ui,sans-serif}
.brand svg{width:84px;height:84px}
h1{margin-top:44px;font-size:${size}px;line-height:1.14;font-weight:700;max-width:1040px}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font:30px 'Segoe UI',system-ui,sans-serif;color:#9a968d}
.tags{display:flex;gap:14px}.tags span{border:2px solid #3a3a40;border-radius:999px;padding:6px 20px;font-size:26px;color:#c9c5bc}
.cmd{font:28px Consolas,'Courier New',monospace;color:#ff8a5c}
</style>
<div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#d9480f"/><polyline points="10,11 15,16 10,21" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="17" y1="22" x2="23" y2="22" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>${esc(cfg.title)}</div>
<h1>${esc(post.title)}</h1>
<div class="foot"><div class="tags">${post.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div><div class="cmd">$ sudo explain</div></div>`;
};

// The home page card, static/og.png. It uses the tagline, author and eyebrow from site.config.json.
const homeCard = () => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#121214;color:#ece9e1;font-family:Georgia,'Palatino Linotype',serif;border-top:10px solid #ff8a5c;padding:70px 80px 56px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:26px;font:700 40px 'Segoe UI',system-ui,sans-serif}
.brand svg{width:84px;height:84px}
h1{margin-top:44px;font-size:92px;line-height:1.1;font-weight:700;max-width:1040px}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font:30px 'Segoe UI',system-ui,sans-serif;color:#9a968d}
.cmd{font:28px Consolas,'Courier New',monospace;color:#ff8a5c}
</style>
<div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#d9480f"/><polyline points="10,11 15,16 10,21" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="17" y1="22" x2="23" y2="22" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>${esc(cfg.title)}</div>
<h1>${esc(cfg.tagline)}</h1>
<div class="foot"><div>${esc(cfg.author)}</div><div class="cmd">${esc(cfg.eyebrow)}</div></div>`;

const posts = readdirSync(join(ROOT, 'content', 'posts'))
  .filter((f) => f.endsWith('.md'))
  .map(readPost)
  .filter(Boolean);

mkdirSync(join(ROOT, 'static', 'og'), { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'og-'));
let failed = 0;

for (const post of posts) {
  const html = join(work, `${post.slug}.html`);
  const png = join(ROOT, 'static', 'og', `${post.slug}.png`);
  writeFileSync(html, card(post));
  const run = spawnSync(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,630', `--screenshot=${png}`, pathToFileURL(html).href],
    { stdio: 'ignore', timeout: 60000 },
  );
  if (run.status === 0 && existsSync(png)) console.log(`  made  static/og/${post.slug}.png`);
  else {
    failed++;
    console.error(`  FAILED  ${post.slug}`);
  }
}

{
  const html = join(work, 'home.html');
  const png = join(ROOT, 'static', 'og.png');
  writeFileSync(html, homeCard());
  const run = spawnSync(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,630', `--screenshot=${png}`, pathToFileURL(html).href],
    { stdio: 'ignore', timeout: 60000 },
  );
  if (run.status === 0 && existsSync(png)) console.log('  made  static/og.png (home page)');
  else {
    failed++;
    console.error('  FAILED  static/og.png');
  }
}

rmSync(work, { recursive: true, force: true });
console.log(posts.length ? `\n${posts.length - failed} of ${posts.length} card(s) written.` : 'No published posts yet.');
process.exit(failed ? 1 : 0);
