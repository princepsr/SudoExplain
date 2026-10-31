// Client-side search over /search-index.json (built by build.mjs). No dependencies.
// Every term must match somewhere in a post; title and tag matches rank higher.
// Results are built with DOM methods only, so post text can never inject markup.
(() => {
  const box = document.getElementById('search-box');
  const input = document.getElementById('search');
  const status = document.getElementById('search-status');
  const results = document.getElementById('search-results');
  const groups = document.getElementById('post-groups');
  if (!box || !input || !status || !results || !groups) return;

  box.hidden = false;

  let index = null;
  let loading = null;
  let timer = 0;

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const prepare = (entry) => ({
    ...entry,
    lowTitle: entry.title.toLowerCase(),
    lowDescription: entry.description.toLowerCase(),
    // Tags are shown as "System design" but readers may type "system-design", so match both spellings.
    lowTags: entry.tags.flatMap((t) => [t, t.replace(/\s+/g, '-')]).join(' ').toLowerCase(),
    lowText: entry.text.toLowerCase(),
  });

  const load = () => {
    if (!loading) {
      loading = fetch(input.dataset.index)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          index = data.map(prepare);
        })
        .catch((err) => {
          loading = null;
          throw err;
        });
    }
    return loading;
  };

  const find = (terms) => {
    const hits = [];
    for (const entry of index) {
      let score = 0;
      let matchesAll = true;
      for (const term of terms) {
        const inTitle = entry.lowTitle.includes(term);
        const inTags = entry.lowTags.includes(term);
        const inDescription = entry.lowDescription.includes(term);
        const inText = entry.lowText.includes(term);
        if (!(inTitle || inTags || inDescription || inText)) {
          matchesAll = false;
          break;
        }
        score += (inTitle ? 5 : 0) + (inTags ? 3 : 0) + (inDescription ? 2 : 0) + (inText ? 1 : 0);
      }
      if (matchesAll) hits.push({ entry, score });
    }
    return hits.sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1));
  };

  // Text with every search term wrapped in <mark>, built from text nodes only.
  const highlight = (text, matcher) => {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(matcher)) {
      fragment.append(text.slice(last, match.index));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      fragment.append(mark);
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last));
    return fragment;
  };

  const snippet = (entry, terms) => {
    const hasTerm = (s) => terms.some((t) => s.includes(t));
    if (hasTerm(entry.lowDescription)) return entry.description;
    const positions = terms.map((t) => entry.lowText.indexOf(t)).filter((p) => p >= 0);
    if (!positions.length) return entry.description;
    const at = Math.min(...positions);
    const start = Math.max(0, at - 70);
    const end = Math.min(entry.text.length, at + 120);
    return `${start > 0 ? '…' : ''}${entry.text.slice(start, end).trim()}${end < entry.text.length ? '…' : ''}`;
  };

  const formatDate = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const resultItem = ({ entry }, terms, matcher) => {
    const item = document.createElement('li');
    item.className = 'post-item';

    const time = document.createElement('time');
    time.dateTime = entry.date;
    time.textContent = formatDate(entry.date);

    const heading = document.createElement('h3');
    const link = document.createElement('a');
    link.href = entry.url;
    link.append(highlight(entry.title, matcher));
    heading.append(link);

    const excerpt = document.createElement('p');
    excerpt.append(highlight(snippet(entry, terms), matcher));

    item.append(time, heading, excerpt);

    if (entry.tags.length) {
      const tags = document.createElement('ul');
      tags.className = 'tags';
      for (const tag of entry.tags) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = tag;
        li.append(span);
        tags.append(li);
      }
      item.append(tags);
    }
    return item;
  };

  const showAll = () => {
    results.hidden = true;
    status.hidden = true;
    groups.hidden = false;
  };

  const render = () => {
    const query = input.value.trim();
    if (!query) {
      showAll();
      return;
    }
    const terms = query.toLowerCase().split(/\s+/);
    const matcher = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
    const hits = find(terms);

    const list = document.createElement('ul');
    list.className = 'post-list';
    for (const hit of hits) list.append(resultItem(hit, terms, matcher));
    results.replaceChildren(list);

    status.textContent = hits.length
      ? `${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}"`
      : `No posts match "${query}". Try fewer or different words.`;
    groups.hidden = true;
    results.hidden = !hits.length;
    status.hidden = false;
  };

  const run = () => {
    if (!input.value.trim()) {
      showAll();
      return;
    }
    load()
      .then(render)
      .catch(() => {
        status.textContent = 'Search is unavailable right now. Browse the full list below instead.';
        status.hidden = false;
        results.hidden = true;
        groups.hidden = false;
      });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 100);
  });

  input.addEventListener('focus', () => {
    load().catch(() => {});
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (input.value) {
      input.value = '';
      showAll();
    } else {
      input.blur();
    }
  });

  addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      input.focus();
    }
  });

  const focusFromHash = () => {
    if (location.hash === '#search') input.focus();
  };
  addEventListener('hashchange', focusFromHash);
  focusFromHash();

  const initial = new URLSearchParams(location.search).get('q');
  if (initial) {
    input.value = initial;
    run();
  }
})();
