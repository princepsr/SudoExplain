// Zero-dependency static site generator. Node built-ins only.
//   node build.mjs            build into dist/
//   node build.mjs --serve    build + serve on http://localhost:4000 (includes drafts, rebuilds on change)
//   node build.mjs --drafts   build including drafts

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const ARGS = new Set(process.argv.slice(2));
const SERVE = ARGS.has('--serve');
const DRAFTS = SERVE || ARGS.has('--drafts');

let cfg = {};

// ---------- Helpers ----------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const withBase = (href) => (href.startsWith('/') && !href.startsWith('//') ? cfg.basePath + href : href);

const fmtDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

const isoDay = (d) => d.toISOString().slice(0, 10);

// ---------- Markdown ----------

function inline(src) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let t = src.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img src="${withBase(url)}" alt="${alt}" loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const external = /^https?:/.test(url);
    return `<a href="${withBase(url)}"${external ? ' rel="noopener"' : ''}>${text}</a>`;
  });
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');

  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
}

// ---------- Syntax highlighting (build time, no client JS) ----------
// One combined regex per language. Rules are tried in listed order at each position, so
// comments and strings must come before keywords. Rule patterns must not contain capture groups.

const words = (list) => String.raw`\b(?:${list.trim().split(/\s+/).join('|')})\b`;

const P = {
  slashComment: String.raw`//.*|/\*[\s\S]*?\*/`,
  hashComment: String.raw`#.*`,
  dq: String.raw`"(?:\\.|[^"\\\n])*"`,
  sq: String.raw`'(?:\\.|[^'\\\n])*'`,
  tpl: '`(?:\\\\.|[^`\\\\])*`',
  number: String.raw`\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlL]?\b`,
  type: String.raw`\b[A-Z]\w*\b`,
  fn: String.raw`\b[a-z_]\w*(?=\()`,
};

const JAVA_KW = `abstract assert boolean break byte case catch char class const continue default do double else enum extends
  final finally float for if implements import instanceof int interface long native new package private protected public
  record return short static super switch synchronized this throw throws transient try var void volatile while yield sealed permits`;
const JS_KW = `async await break case catch class const continue debugger default delete do else enum export extends finally for
  from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield
  interface type implements readonly public private protected abstract as`;
const PY_KW = `and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield`;
const SH_KW = `if then elif else fi for while until do done case esac function in select export local return exit echo cd source alias unset read set`;
const SQL_KW = `select from where join left right inner outer full cross on group by order having insert into values update set delete
  create table alter drop index primary key foreign references and or not null as distinct limit offset union all case when then
  else end in like is exists between asc desc with default unique constraint view`;

const LANGS = {
  java: {
    rules: [
      ['comment', P.slashComment],
      ['string', String.raw`"""[\s\S]*?"""|${P.dq}|${P.sq}`],
      ['annotation', String.raw`@\w+`],
      ['keyword', words(JAVA_KW)],
      ['literal', words('true false null')],
      ['number', P.number],
      ['type', P.type],
      ['fn', P.fn],
    ],
  },
  js: {
    rules: [
      ['comment', P.slashComment],
      ['string', `${P.dq}|${P.sq}|${P.tpl}`],
      ['keyword', words(JS_KW)],
      ['literal', words('true false null undefined NaN Infinity')],
      ['number', P.number],
      ['type', P.type],
      ['fn', P.fn],
    ],
  },
  python: {
    rules: [
      ['comment', P.hashComment],
      ['string', String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|${P.dq}|${P.sq}`],
      ['annotation', String.raw`@\w+`],
      ['keyword', words(PY_KW)],
      ['literal', words('True False None')],
      ['number', P.number],
      ['type', P.type],
      ['fn', P.fn],
    ],
  },
  bash: {
    rules: [
      ['comment', P.hashComment],
      ['string', `${P.dq}|${P.sq}`],
      ['variable', String.raw`\$(?:\{[^}]*\}|[\w@#?!*]+)`],
      ['keyword', words(SH_KW)],
      ['attr', String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
    ],
  },
  sql: {
    flags: 'gmi',
    rules: [
      ['comment', String.raw`--.*|/\*[\s\S]*?\*/`],
      ['string', String.raw`'(?:''|[^'])*'`],
      ['keyword', words(SQL_KW)],
      ['number', String.raw`\b\d+(?:\.\d+)?\b`],
      ['fn', String.raw`\b[a-z_]\w*(?=\()`],
    ],
  },
  json: {
    rules: [
      ['prop', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
      ['string', P.dq],
      ['literal', words('true false null')],
      ['number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ],
  },
  yaml: {
    rules: [
      ['comment', String.raw`(?<=^|\s)#.*`],
      ['prop', String.raw`^[ \t]*(?:-[ \t]+)?[\w./-]+(?=:)`],
      ['string', `${P.dq}|${P.sq}`],
      ['literal', words('true false null yes no on off')],
      ['number', String.raw`\b\d+(?:\.\d+)?\b`],
    ],
  },
  markup: {
    rules: [
      ['comment', String.raw`<!--[\s\S]*?-->`],
      ['string', String.raw`(?<==)(?:"[^"]*"|'[^']*')`],
      ['tag', String.raw`</?[A-Za-z][\w:-]*|/?>`],
      ['attr', String.raw`[\w:-]+(?==)`],
    ],
  },
};

const LANG_ALIASES = {
  java: 'java',
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', typescript: 'js', ts: 'js', tsx: 'js',
  python: 'python', py: 'python',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  html: 'markup', xml: 'markup', svg: 'markup',
};

const compiledLangs = new Map();

function compileLang(name) {
  if (!compiledLangs.has(name)) {
    const def = LANGS[name];
    const re = new RegExp(def.rules.map(([, src]) => `(${src})`).join('|'), def.flags || 'gm');
    compiledLangs.set(name, { re, classes: def.rules.map(([cls]) => cls) });
  }
  return compiledLangs.get(name);
}

// Returns HTML-escaped code, wrapped in <span class="tok-*"> for recognised tokens.
// Time: O(n) in code length. Unknown languages are escaped and returned unhighlighted.
function highlight(code, lang) {
  const name = LANG_ALIASES[lang.toLowerCase()];
  if (!name) return esc(code);

  const { re, classes } = compileLang(name);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const group = m.findIndex((g, i) => i > 0 && g !== undefined) - 1;
    out += `${esc(code.slice(last, m.index))}<span class="tok-${classes[group]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

const isBlockStart = (line) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line) || line.startsWith('>') || line.startsWith('<');

const tableCells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

const isTableStart = (lines, i) =>
  lines[i].includes('|') &&
  i + 1 < lines.length &&
  lines[i + 1].includes('|') &&
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]);

function table(lines, start) {
  const head = tableCells(lines[start]);
  const align = tableCells(lines[start + 1]).map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    return c.endsWith(':') ? 'right' : '';
  });
  const cell = (tag, text, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(text)}</${tag}>`;

  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(`<tr>${tableCells(lines[i]).map((c, n) => cell('td', c, n)).join('')}</tr>`);
    i++;
  }

  const thead = `<thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>`;
  return [`<div class="table-wrap"><table>${thead}<tbody>${rows.join('')}</tbody></table></div>`, i];
}

function list(lines, start) {
  const base = lines[start].match(LIST_ITEM)[1].length;
  const tag = /^\s*\d+\./.test(lines[start]) ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || m[1].length < base) break;
    if (m[1].length > base) {
      const [nested, next] = list(lines, i);
      html = html.replace(/<\/li>$/, `${nested}</li>`);
      i = next;
    } else {
      html += `<li>${inline(m[3])}</li>`;
      i++;
    }
  }
  return [`${html}</${tag}>`, i];
}

function markdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const seen = new Map();
  const out = [];
  let i = 0;

  const heading = (level, text) => {
    let id = slugify(text.replace(/[`*]/g, ''));
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    const anchor = level > 1 ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : '';
    return `<h${level} id="${id}">${anchor}${inline(text)}</h${level}>`;
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (!line.trim()) {
      i++;
    } else if ((m = line.match(FENCE))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const label = m[1] ? ` data-lang="${esc(m[1])}"` : '';
      out.push(`<pre${label}><code>${highlight(buf.join('\n'), m[1])}</code></pre>`);
    } else if ((m = line.match(HEADING))) {
      out.push(heading(m[1].length, m[2]));
      i++;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`);
    } else if (isTableStart(lines, i)) {
      const [html, next] = table(lines, i);
      out.push(html);
      i = next;
    } else if (LIST_ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
    } else if (line.startsWith('<')) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push(buf.join('\n'));
    } else {
      const buf = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

function parseFrontMatter(raw) {
  const m = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

// ---------- Content loading ----------

// First prose paragraph, stripped of Markdown, trimmed to a search-snippet length.
function excerpt(body, max = 160) {
  const para = body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .find((b) => /^[A-Za-z"'*_]/.test(b));
  if (!para) return '';
  const text = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

function loadPosts() {
  const dir = join(ROOT, 'content', 'posts');
  if (!existsSync(dir)) return [];

  const posts = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const { meta, body } = parseFrontMatter(readFileSync(join(dir, file), 'utf8'));
      const date = new Date(meta.date);
      const updated = meta.updated ? new Date(meta.updated) : date;
      if (!meta.title || Number.isNaN(date.getTime()) || Number.isNaN(updated.getTime())) {
        throw new Error(`${file}: front matter needs "title" and a valid "date" (YYYY-MM-DD); "updated" is optional but must be a valid date`);
      }
      return {
        slug: meta.slug || file.replace(/\.md$/, ''),
        title: meta.title,
        description: meta.description || excerpt(body),
        date,
        updated,
        draft: meta.draft === 'true',
        tags: (meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        minutes: Math.max(1, Math.round(body.split(/\s+/).length / 220)),
        html: markdown(body),
      };
    })
    .filter((p) => DRAFTS || !p.draft)
    .sort((a, b) => b.date - a.date);

  return posts;
}

function loadPage(name) {
  const file = join(ROOT, 'content', `${name}.md`);
  if (!existsSync(file)) return null;
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  return { title: meta.title || name, description: meta.description || '', html: markdown(body) };
}

// ---------- Templates ----------

const ICON_THEME =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>';

function layout({
  title,
  description,
  path,
  body,
  type = 'website',
  nav = '',
  fullTitle = '',
  published = '',
  modified = '',
  noindex = false,
  jsonLd = null,
}) {
  const pageTitle = fullTitle || (title ? `${title} · ${cfg.title}` : cfg.title);
  const desc = description || cfg.description;
  const canonical = `${cfg.url}${cfg.basePath}${path}`;
  const image = cfg.ogImage ? `${cfg.url}${cfg.basePath}${cfg.ogImage}` : '';
  const structured = jsonLd ? JSON.stringify(jsonLd).replace(/</g, '\\u003c') : '';
  const cssHash = createHash('sha1').update(readFileSync(join(ROOT, 'assets', 'style.css'))).digest('hex').slice(0, 8);
  const link = (href, label) =>
    `<a href="${withBase(href)}"${nav === href ? ' aria-current="page"' : ''}>${label}</a>`;
  const social = [
    cfg.github && `<a href="${esc(cfg.github)}" rel="noopener">GitHub</a>`,
    cfg.linkedin && `<a href="${esc(cfg.linkedin)}" rel="noopener">LinkedIn</a>`,
    `<a href="${withBase('/rss.xml')}">RSS</a>`,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="${cfg.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfaf6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121214" media="(prefers-color-scheme: dark)">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="${withBase('/favicon.svg')}" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(cfg.title)}" href="${withBase('/rss.xml')}">
<meta name="author" content="${esc(cfg.author)}">${noindex ? '\n<meta name="robots" content="noindex, follow">' : ''}
<meta property="og:site_name" content="${esc(cfg.title)}">
<meta property="og:title" content="${esc(fullTitle || title || cfg.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${type}">
<meta property="og:url" content="${esc(canonical)}">${image ? `\n<meta property="og:image" content="${esc(image)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image:alt" content="${esc(cfg.title)}: ${esc(cfg.tagline)}">` : ''}${published ? `\n<meta property="article:published_time" content="${published}">` : ''}${modified ? `\n<meta property="article:modified_time" content="${modified}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(fullTitle || title || cfg.title)}">
<meta name="twitter:description" content="${esc(desc)}">${image ? `\n<meta name="twitter:image" content="${esc(image)}">` : ''}${structured ? `\n<script type="application/ld+json">${structured}</script>` : ''}
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="stylesheet" href="${withBase('/assets/style.css')}?v=${cssHash}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${withBase('/')}"><span class="brand-mark" aria-hidden="true">&gt;_</span>${esc(cfg.title)}</a>
    <nav class="site-nav" aria-label="Main">
      ${link('/posts/', 'Writing')}
      ${link('/tags/', 'Topics')}
      ${link('/about/', 'About')}
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle light or dark theme">${ICON_THEME}</button>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <span>&copy; ${new Date().getUTCFullYear()} ${esc(cfg.author)}</span>
    <span class="footer-links">${social.join('')}</span>
  </div>
</footer>
<script src="${withBase('/assets/theme.js')}" defer></script>
</body>
</html>
`;
}

const tagList = (tags, links = true) =>
  tags.length
    ? `<ul class="tags">${tags
        .map((t) => `<li>${links ? `<a href="${withBase(`/tags/${slugify(t)}/`)}">${esc(t)}</a>` : `<span>${esc(t)}</span>`}</li>`)
        .join('')}</ul>`
    : '';

const postItem = (p) => `<li class="post-item">
  <time datetime="${isoDay(p.date)}">${fmtDate(p.date)}</time>
  <h3><a href="${withBase(`/posts/${p.slug}/`)}">${esc(p.title)}</a>${p.draft ? ' <span class="draft">(draft)</span>' : ''}</h3>
  ${p.description ? `<p>${esc(p.description)}</p>` : ''}
  ${tagList(p.tags)}
</li>`;

const postItems = (posts) => `<ul class="post-list">${posts.map(postItem).join('')}</ul>`;

const emptyState = '<p class="empty">Nothing here yet. First post coming soon.</p>';

function homePage(posts) {
  const latest = posts.slice(0, 5);
  return layout({
    title: '',
    fullTitle: `${cfg.title}: ${cfg.tagline}`,
    path: '/',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: cfg.title,
      url: `${cfg.url}${cfg.basePath}/`,
      description: cfg.description,
      inLanguage: cfg.lang,
      author: { '@type': 'Person', name: cfg.author },
    },
    body: `<div class="wrap">
  <section class="hero">
    <p class="eyebrow">${esc(cfg.eyebrow)}</p>
    <h1>${esc(cfg.tagline)}</h1>
    <p class="lede">${esc(cfg.description)}</p>
  </section>
  <h2 class="section-title"><span>Latest writing</span><a href="${withBase('/posts/')}">All posts &rarr;</a></h2>
  ${latest.length ? postItems(latest) : emptyState}
</div>`,
  });
}

function archivePage(posts) {
  const years = [...new Set(posts.map((p) => p.date.getUTCFullYear()))];
  const groups = years
    .map((y) => `<h2 class="year">${y}</h2>${postItems(posts.filter((p) => p.date.getUTCFullYear() === y))}`)
    .join('');
  return layout({
    title: 'Writing',
    description: 'Every post, newest first.',
    path: '/posts/',
    nav: '/posts/',
    body: `<div class="narrow">
  <header class="page-head"><h1>Writing</h1><p>${posts.length} post${posts.length === 1 ? '' : 's'}, newest first.</p></header>
  ${posts.length ? groups : emptyState}
</div>`,
  });
}

// "On this page" list built from the h2 headings; only for posts with at least three sections.
function tableOfContents(html) {
  const items = [...html.matchAll(/<h2 id="([^"]+)">(?:<a class="anchor"[^>]*>#<\/a>)?(.*?)<\/h2>/g)].map(([, id, inner]) => ({
    id,
    text: inner.replace(/<[^>]+>/g, ''),
  }));
  if (items.length < 3) return '';
  const links = items.map((i) => `<li><a href="#${i.id}">${i.text}</a></li>`).join('');
  return `<aside class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${links}</ul></aside>`;
}

function postPage(post, newer, older) {
  const toc = tableOfContents(post.html);
  const pager = `<nav class="pager" aria-label="More posts">
  ${older ? `<a class="prev" href="${withBase(`/posts/${older.slug}/`)}"><small>&larr; Older</small>${esc(older.title)}</a>` : '<span></span>'}
  ${newer ? `<a class="next" href="${withBase(`/posts/${newer.slug}/`)}"><small>Newer &rarr;</small>${esc(newer.title)}</a>` : ''}
</nav>`;

  return layout({
    title: post.title,
    description: post.description,
    path: `/posts/${post.slug}/`,
    nav: '/posts/',
    type: 'article',
    published: isoDay(post.date),
    modified: isoDay(post.updated),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.description,
      datePublished: isoDay(post.date),
      dateModified: isoDay(post.updated),
      url: `${cfg.url}${cfg.basePath}/posts/${post.slug}/`,
      mainEntityOfPage: `${cfg.url}${cfg.basePath}/posts/${post.slug}/`,
      keywords: post.tags.join(', '),
      inLanguage: cfg.lang,
      author: { '@type': 'Person', name: cfg.author },
      publisher: { '@type': 'Person', name: cfg.author },
    },
    body: `<div class="post-layout${toc ? ' has-toc' : ''}">
<article class="post">
  <header class="post-head">
    <p class="meta"><time datetime="${isoDay(post.date)}">${fmtDate(post.date)}</time> &middot; ${post.minutes} min read${post.draft ? ' &middot; <span class="draft">Draft</span>' : ''}</p>
    <h1>${esc(post.title)}</h1>
    ${post.description ? `<p class="lede">${esc(post.description)}</p>` : ''}
    ${tagList(post.tags)}
  </header>
  <div class="prose">
${post.html}
  </div>
  ${pager}
</article>
${toc}
</div>`,
  });
}

function tagsIndexPage(tagMap) {
  const items = [...tagMap.entries()]
    .sort((a, b) => b[1].posts.length - a[1].posts.length || a[1].name.localeCompare(b[1].name))
    .map(([slug, t]) => `<li><a href="${withBase(`/tags/${slug}/`)}">${esc(t.name)}<small>${t.posts.length}</small></a></li>`)
    .join('');
  return layout({
    title: 'Topics',
    description: 'Browse posts by topic.',
    path: '/tags/',
    nav: '/tags/',
    body: `<div class="narrow">
  <header class="page-head"><h1>Topics</h1><p>Browse posts by subject.</p></header>
  ${items ? `<ul class="tag-cloud">${items}</ul>` : emptyState}
</div>`,
  });
}

function tagPage(slug, tag) {
  return layout({
    title: `Topic: ${tag.name}`,
    description: `Posts about ${tag.name}.`,
    path: `/tags/${slug}/`,
    noindex: true,
    nav: '/tags/',
    body: `<div class="narrow">
  <header class="page-head"><h1>${esc(tag.name)}</h1><p>${tag.posts.length} post${tag.posts.length === 1 ? '' : 's'}. <a href="${withBase('/tags/')}">All topics</a></p></header>
  ${postItems(tag.posts)}
</div>`,
  });
}

function staticPage(page, path, jsonLd = null) {
  return layout({
    title: page.title,
    description: page.description,
    path,
    nav: path,
    jsonLd,
    body: `<div class="narrow">
  <header class="page-head"><h1>${esc(page.title)}</h1></header>
  <div class="prose">
${page.html}
  </div>
</div>`,
  });
}

function notFoundPage() {
  return layout({
    title: 'Not found',
    path: '/404.html',
    noindex: true,
    body: `<div class="narrow">
  <header class="page-head"><h1>Page not found</h1><p>That page doesn't exist (or moved). <a href="${withBase('/')}">Go home</a> or browse <a href="${withBase('/posts/')}">all posts</a>.</p></header>
</div>`,
  });
}

// ---------- Feeds ----------

function rssFeed(posts) {
  const base = cfg.url + cfg.basePath;
  const items = posts
    .slice(0, 20)
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${base}/posts/${p.slug}/</link>
      <guid>${base}/posts/${p.slug}/</guid>
      <pubDate>${p.date.toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(cfg.title)}</title>
    <link>${base}/</link>
    <description>${esc(cfg.description)}</description>
    <language>${cfg.lang}</language>
${items}
  </channel>
</rss>
`;
}

function sitemap(entries) {
  const base = cfg.url + cfg.basePath;
  const urls = entries
    .map((e) => `  <url><loc>${base}${e.path}</loc>${e.date ? `<lastmod>${isoDay(e.date)}</lastmod>` : ''}</url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ---------- Build ----------

function emit(path, html) {
  const file = path.endsWith('/') ? join(DIST, path, 'index.html') : join(DIST, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

function build() {
  const started = Date.now();
  cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
  if (SERVE) cfg.basePath = '';

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  for (const dir of ['static', 'assets']) {
    const from = join(ROOT, dir);
    if (existsSync(from)) cpSync(from, dir === 'assets' ? join(DIST, 'assets') : DIST, { recursive: true });
  }

  const posts = loadPosts();
  const tagMap = new Map();
  for (const p of posts) {
    for (const name of p.tags) {
      const slug = slugify(name);
      if (!tagMap.has(slug)) tagMap.set(slug, { name, posts: [] });
      tagMap.get(slug).posts.push(p);
    }
  }

  const paths = [{ path: '/' }, { path: '/posts/' }, { path: '/tags/' }];
  emit('/', homePage(posts));
  emit('/posts/', archivePage(posts));
  emit('/tags/', tagsIndexPage(tagMap));
  emit('/404.html', notFoundPage());

  posts.forEach((p, i) => {
    emit(`/posts/${p.slug}/`, postPage(p, posts[i - 1], posts[i + 1]));
    if (!p.draft) paths.push({ path: `/posts/${p.slug}/`, date: p.updated });
  });
  for (const [slug, tag] of tagMap) {
    emit(`/tags/${slug}/`, tagPage(slug, tag));
  }

  const about = loadPage('about');
  if (about) {
    const profile = {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      mainEntity: {
        '@type': 'Person',
        name: cfg.author,
        url: `${cfg.url}${cfg.basePath}/about/`,
        sameAs: [cfg.github, cfg.linkedin].filter(Boolean),
      },
    };
    emit('/about/', staticPage(about, '/about/', profile));
    paths.push({ path: '/about/' });
  }

  const published = posts.filter((p) => !p.draft);
  emit('/rss.xml', rssFeed(published));
  emit('/sitemap.xml', sitemap(paths));
  emit('/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${cfg.url}${cfg.basePath}/sitemap.xml\n`);

  console.log(`Built ${posts.length} post(s) in ${Date.now() - started}ms -> dist/`);
}

// ---------- Dev server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function serve(port = 4000) {
  const respond = (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(DIST, `.${urlPath}`);

    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] }).end(readFileSync(join(DIST, '404.html')));
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  };

  createServer((req, res) => {
    try {
      respond(req, res);
    } catch (err) {
      // dist/ is briefly missing while a rebuild runs, or the URL is malformed: answer instead of crashing
      console.warn(`Request ${req.url} failed: ${err.message}`);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Rebuilding, refresh in a moment.');
    }
  }).listen(port, () => console.log(`Serving http://localhost:${port}  (drafts visible, rebuilds on save)`));

  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
      } catch (err) {
        console.error(`Build failed: ${err.message}`);
      }
    }, 150);
  };
  for (const target of ['content', 'assets', 'static', 'site.config.json']) {
    const path = join(ROOT, target);
    if (existsSync(path)) watch(path, { recursive: true }, rebuild);
  }
}

build();
if (SERVE) serve();
