// Client-side search over /search-index.json (built by build.mjs). No dependencies.
// Every term must match the start of a word in a post ("lock" finds "locks" but not "block").
// Title, tags and section headings rank above the description, and the description above the body.
// Posts that match only in the body text are listed in a separate group after the stronger matches.
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

  // Words that would otherwise have to appear in every result ("why the cache is stale").
  const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it', 'my', 'how', 'why', 'what', 'do', 'does', 'for', 'with']);
  const isWordChar = (ch) => /[a-z0-9]/.test(ch);

  // Search terms: lower case, with stop words dropped.
  const toTerms = (query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const useful = words.filter((w) => !STOP_WORDS.has(w));
    return useful.length ? useful : words;
  };

  // "pools" should also find the whole word "pool", but "cors" must not become "cor" and find "correlation".
  const singular = (term) => (term.length > 4 && term.endsWith('s') && !/(ss|us|is)$/.test(term) ? term.slice(0, -1) : '');

  // Position of the first occurrence of `term` at the start of a word, or -1.
  const wordStart = (haystack, term) => {
    for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + 1)) {
      if (at === 0 || !isWordChar(haystack[at - 1])) return at;
    }
    return -1;
  };

  // Where `term` matches in `haystack`: at the start of a word, or as the exact singular of a plural term. -1 if it does not.
  const locate = (haystack, term) => {
    const at = wordStart(haystack, term);
    if (at >= 0) return at;
    const one = singular(term);
    if (!one) return -1;
    for (let i = haystack.indexOf(one); i !== -1; i = haystack.indexOf(one, i + 1)) {
      const before = i === 0 || !isWordChar(haystack[i - 1]);
      const after = i + one.length >= haystack.length || !isWordChar(haystack[i + one.length]);
      if (before && after) return i;
    }
    return -1;
  };

  const prepare = (entry) => ({
    ...entry,
    lowTitle: entry.title.toLowerCase(),
    lowHeadings: (entry.headings || []).join(' ').toLowerCase(),
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
      let strong = true; // every term appears in the title, tags, a heading or the description
      for (const term of terms) {
        const inTitle = locate(entry.lowTitle, term) >= 0;
        const inTags = locate(entry.lowTags, term) >= 0;
        const inHeadings = locate(entry.lowHeadings, term) >= 0;
        const inDescription = locate(entry.lowDescription, term) >= 0;
        const inText = locate(entry.lowText, term) >= 0;
        if (!(inTitle || inTags || inHeadings || inDescription || inText)) {
          matchesAll = false;
          break;
        }
        if (!(inTitle || inTags || inHeadings || inDescription)) strong = false;
        score += (inTitle ? 10 : 0) + (inTags ? 6 : 0) + (inHeadings ? 4 : 0) + (inDescription ? 3 : 0) + (inText ? 1 : 0);
      }
      if (matchesAll) hits.push({ entry, score, strong });
    }
    return hits.sort((a, b) => b.strong - a.strong || b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1));
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
    const hasTerm = (s) => terms.some((t) => locate(s, t) >= 0);
    if (hasTerm(entry.lowDescription)) return entry.description;
    const positions = terms.map((t) => locate(entry.lowText, t)).filter((p) => p >= 0);
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
    const terms = toTerms(query);
    const pattern = terms.flatMap((t) => [t, singular(t)]).filter(Boolean).map(escapeRegExp).join('|');
    // Highlight only where a word starts with a term, like the search itself; older browsers without lookbehind highlight anywhere.
    let matcher;
    try {
      matcher = new RegExp(`(?<![a-z0-9])(?:${pattern})`, 'gi');
    } catch {
      matcher = new RegExp(pattern, 'gi');
    }
    const hits = find(terms);

    // Strong matches first; posts that only mention the words in their text go in a second, labelled group.
    const makeList = (items) => {
      const list = document.createElement('ul');
      list.className = 'post-list';
      for (const hit of items) list.append(resultItem(hit, terms, matcher));
      return list;
    };
    const strong = hits.filter((h) => h.strong);
    const weak = hits.filter((h) => !h.strong);
    const parts = [];
    if (strong.length) parts.push(makeList(strong));
    if (weak.length) {
      const label = document.createElement('h2');
      label.className = 'search-group';
      label.textContent = strong.length ? 'Also mentioned in the text' : 'Mentioned in the text';
      parts.push(label, makeList(weak));
    }
    results.replaceChildren(...parts);

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
