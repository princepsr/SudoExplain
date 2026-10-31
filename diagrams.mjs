// Turns a small text description into a figure with two SVG versions: a wide one for larger screens and an
// upright one for phones (the stylesheet shows the right one). Used for ```diagram blocks in posts.
// Zero dependencies. The syntax is documented in docs/writing.md.
//
//   ```diagram
//   type: sequence            (or: flow)
//   alt: Plain-words description for screen readers
//   caption: Figure 1. What the reader should notice.
//   actors: Client | Server | Card provider
//   Client -> Server: POST /charge
//   Server --> Client: reply        (dashed arrow)
//   Server -x Client: reply lost !  (arrow that never arrives; a trailing "!" draws it in the accent colour)
//   note Client: it sees a timeout  (a note box; "note all:" spans the whole diagram)
//   ```
//
//   ```diagram
//   type: flow
//   alt: ...
//   caption: ...
//   Request arrives -> Slow call holds a connection -> Pool is empty -> Requests time out !
//   ```

const CHAR = 0.58; // average glyph width as a share of the font size, for wrapping text without font metrics
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (n) => Math.round(n * 10) / 10;

// Greedy word wrap to a character budget. A single long word is left whole.
function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const longestWord = (texts) => Math.max(1, ...texts.flatMap((t) => String(t).split(/\s+/).map((w) => w.length)));

function parse(src) {
  const meta = { type: 'sequence', alt: '', caption: '', actors: [] };
  const body = [];
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = !body.length && line.match(/^(type|alt|caption|actors)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === 'actors') meta.actors = m[2].split('|').map((s) => s.trim()).filter(Boolean);
      else meta[key] = m[2].trim();
    } else {
      body.push(line);
    }
  }
  return { meta, body };
}

// ---------- sequence diagrams ----------

function sequence(meta, body, size, uid) {
  const { W, pad, fs } = size;
  const actors = meta.actors;
  const n = actors.length;
  const gap = (W - 2 * pad) / n;
  const laneX = (i) => pad + gap * (i + 0.5);
  const index = (name) => {
    const i = actors.findIndex((a) => a.toLowerCase() === name.trim().toLowerCase());
    if (i < 0) throw new Error(`diagram: "${name}" is not in the actors line (${actors.join(', ')})`);
    return i;
  };

  const boxW = Math.min(gap - (W < 400 ? 4 : 10), 160);
  const afs = clamp((boxW - 8) / (longestWord(actors) * CHAR), 9.5, fs);
  const actorLines = actors.map((a) => wrap(a, Math.floor((boxW - 8) / (afs * CHAR))));
  const boxH = Math.max(...actorLines.map((l) => l.length)) * afs * 1.25 + 12;

  const lh = fs * 1.3;
  const maxLabel = Math.floor((W - 2 * pad) / (fs * CHAR));
  let y = boxH + 18;
  const parts = [];

  for (const line of body) {
    const note = line.match(/^note\s+(.+?)\s*:\s*(.*)$/i);
    if (note) {
      const accent = /\s!$/.test(note[2]);
      const lines = wrap(note[2].replace(/\s!$/, ''), Math.floor((W - 2 * pad - 16) / (fs * CHAR)));
      const tw = Math.max(...lines.map((l) => l.length)) * fs * CHAR + 16;
      const cx = note[1].toLowerCase() === 'all' ? W / 2 : laneX(index(note[1]));
      const w = Math.min(tw, W - 2 * pad);
      const x = clamp(cx - w / 2, pad, W - pad - w);
      const h = lines.length * lh + 10;
      parts.push(
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="6" fill="${accent ? 'var(--accent-soft)' : 'var(--surface)'}" stroke="${accent ? 'var(--accent)' : 'var(--line)'}" stroke-width="1.5"/>`,
        ...lines.map((l, k) => `<text x="${num(x + w / 2)}" y="${num(y + 5 + lh * (k + 0.78))}" text-anchor="middle" font-size="${fs}"${accent ? ' fill="var(--accent)"' : ''}>${esc(l)}</text>`),
      );
      y += h + 12;
      continue;
    }

    const msg = line.match(/^(.+?)\s*(-->|->|-x)\s*(.+?)\s*:\s*(.*)$/);
    if (!msg) throw new Error(`diagram: cannot read the line "${line}"`);
    const from = index(msg[1]);
    const to = index(msg[3]);
    const accent = /\s!$/.test(msg[4]) || /^!/.test(msg[4]);
    const label = msg[4].replace(/\s!$/, '').replace(/^!\s*/, '');
    const dashed = msg[2] === '-->';
    const lost = msg[2] === '-x';
    const colour = accent ? 'var(--accent)' : 'currentColor';
    const marker = accent ? `url(#ma${uid})` : `url(#m${uid})`;
    const lines = wrap(label, maxLabel);
    const tw = Math.max(...lines.map((l) => l.length)) * fs * CHAR;
    const self = from === to;
    const x1 = laneX(from);
    const x2 = self ? x1 : laneX(to);
    const mid = self ? x1 + 40 : (x1 + x2) / 2;
    const tx = clamp(mid, pad + tw / 2, W - pad - tw / 2);
    const textBottom = y + lines.length * lh;
    const ay = textBottom + 8;

    lines.forEach((l, k) => {
      parts.push(
        `<text x="${num(tx)}" y="${num(y + lh * (k + 0.78))}" text-anchor="middle" font-size="${fs}"${accent ? ' fill="var(--accent)"' : ''} paint-order="stroke" stroke="var(--bg)" stroke-width="5" stroke-linejoin="round">${esc(l)}</text>`,
      );
    });

    if (self) {
      parts.push(`<path d="M${num(x1)} ${num(ay - 6)} h28 v16 h-28" fill="none" stroke="${colour}" stroke-width="1.8"${dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="${marker}"/>`);
      y = ay + 20;
    } else {
      const dir = Math.sign(x2 - x1);
      const end = lost ? x1 + (x2 - x1) * 0.72 : x2 - dir * 2;
      parts.push(`<line x1="${num(x1)}" y1="${num(ay)}" x2="${num(end)}" y2="${num(ay)}" stroke="${colour}" stroke-width="1.8"${dashed ? ' stroke-dasharray="6 5"' : ''}${lost ? '' : ` marker-end="${marker}"`}/>`);
      if (lost) {
        parts.push(`<path d="M${num(end - 6)} ${num(ay - 6)} l12 12 m0 -12 l-12 12" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round"/>`);
      }
      y = ay + 14;
    }
  }

  const H = Math.ceil(y + 4);
  const head = actors.map((a, i) => {
    const x = laneX(i) - boxW / 2;
    const ls = actorLines[i];
    return (
      `<rect x="${num(x)}" y="4" width="${num(boxW)}" height="${num(boxH)}" rx="7" fill="var(--surface)" stroke="currentColor" stroke-width="1.5"/>` +
      ls.map((l, k) => `<text x="${num(laneX(i))}" y="${num(4 + 6 + afs * 1.25 * (k + 0.85) + (boxH - 12 - ls.length * afs * 1.25) / 2)}" text-anchor="middle" font-size="${num(afs)}" font-weight="600">${esc(l)}</text>`).join('')
    );
  });
  const lifelines = actors.map((_, i) => `<line x1="${num(laneX(i))}" y1="${num(boxH + 4)}" x2="${num(laneX(i))}" y2="${H - 4}" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.5" stroke-dasharray="3 5"/>`);
  return { H, content: lifelines.join('') + head.join('') + parts.join('') };
}

// ---------- flow diagrams ----------

function flow(meta, body, size, uid, vertical) {
  const { W, pad, fs } = size;
  const nodes = body
    .join(' ')
    .split(/\s+->\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ text: s.replace(/\s!$/, ''), accent: /\s!$/.test(s) }));
  if (nodes.length < 2) throw new Error('diagram: a flow needs at least two boxes joined by "->"');
  const n = nodes.length;
  const lh = fs * 1.3;
  const parts = [];

  if (vertical) {
    const w = W - 2 * pad;
    const chars = Math.floor((w - 16) / (fs * CHAR));
    let y = 4;
    nodes.forEach((node, i) => {
      const lines = wrap(node.text, chars);
      const h = lines.length * lh + 16;
      parts.push(nodeSvg(node, pad, y, w, h, lines, fs, lh));
      y += h;
      if (i < n - 1) {
        parts.push(`<line x1="${W / 2}" y1="${num(y)}" x2="${W / 2}" y2="${num(y + 20)}" stroke="currentColor" stroke-width="1.8" marker-end="url(#m${uid})"/>`);
        y += 22;
      }
    });
    return { H: Math.ceil(y + 6), content: parts.join('') };
  }

  const arrow = 28;
  const w = (W - 2 * pad - arrow * (n - 1)) / n;
  const nfs = clamp((w - 12) / (longestWord(nodes.map((x) => x.text)) * CHAR), 10.5, fs);
  const chars = Math.floor((w - 12) / (nfs * CHAR));
  const wrapped = nodes.map((node) => wrap(node.text, chars));
  const nlh = nfs * 1.3;
  const h = Math.max(...wrapped.map((l) => l.length)) * nlh + 18;
  nodes.forEach((node, i) => {
    const x = pad + i * (w + arrow);
    parts.push(nodeSvg(node, x, 4, w, h, wrapped[i], nfs, nlh));
    if (i < n - 1) {
      const ay = 4 + h / 2;
      parts.push(`<line x1="${num(x + w + 3)}" y1="${num(ay)}" x2="${num(x + w + arrow - 3)}" y2="${num(ay)}" stroke="currentColor" stroke-width="1.8" marker-end="url(#m${uid})"/>`);
    }
  });
  return { H: Math.ceil(h + 10), content: parts.join('') };
}

function nodeSvg(node, x, y, w, h, lines, fs, lh) {
  const top = y + (h - lines.length * lh) / 2;
  return (
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8" fill="${node.accent ? 'var(--accent-soft)' : 'var(--surface)'}" stroke="${node.accent ? 'var(--accent)' : 'currentColor'}" stroke-width="1.6"/>` +
    lines.map((l, k) => `<text x="${num(x + w / 2)}" y="${num(top + lh * (k + 0.78))}" text-anchor="middle" font-size="${num(fs)}"${node.accent ? ' fill="var(--accent)" font-weight="600"' : ''}>${esc(l)}</text>`).join('')
  );
}

// ---------- figure ----------

export function renderDiagram(src, uid) {
  const { meta, body } = parse(src);
  if (!meta.alt) throw new Error('diagram: add an "alt:" line that describes the picture in plain words');
  if (meta.type === 'sequence' && meta.actors.length < 2) throw new Error('diagram: a sequence needs an "actors:" line with at least two names');
  if (!['sequence', 'flow'].includes(meta.type)) throw new Error(`diagram: unknown type "${meta.type}" (use sequence or flow)`);

  const build = (variant) => {
    const wide = variant === 'wide';
    const size = wide ? { W: 680, pad: 24, fs: 14 } : { W: 340, pad: 10, fs: 12.5 };
    const drawn = meta.type === 'flow' ? flow(meta, body, size, uid, !wide) : sequence(meta, body, size, uid);
    return (
      `<div class="diagram diagram-${variant}"><svg viewBox="0 0 ${size.W} ${drawn.H}" role="img" aria-label="${esc(meta.alt)}" font-family="var(--sans)" fill="currentColor">` +
      `<defs><marker id="m${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>` +
      `<marker id="ma${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker></defs>` +
      `${drawn.content}</svg></div>`
    );
  };

  // The same id may not appear twice in a page, so the phone version gets its own marker names.
  const wideHtml = build('wide');
  const tallHtml = build('tall').replaceAll(`m${uid}"`, `m${uid}t"`).replaceAll(`#m${uid})`, `#m${uid}t)`).replaceAll(`ma${uid}"`, `ma${uid}t"`).replaceAll(`#ma${uid})`, `#ma${uid}t)`);
  return `<figure>\n${wideHtml}\n${tallHtml}\n${meta.caption ? `<figcaption>${esc(meta.caption)}</figcaption>\n` : ''}</figure>`;
}
