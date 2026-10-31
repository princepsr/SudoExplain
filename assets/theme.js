(() => {
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');

  const current = () =>
    root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  toggle?.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage unavailable: theme still applies for this page view */
    }
  });

  // Highlight the contents-list entry for the section being read.
  const tocLinks = [...document.querySelectorAll('.toc a')];
  const headings = tocLinks
    .map((a) => document.getElementById(a.hash.slice(1)))
    .filter(Boolean);
  if (headings.length) {
    const inner = document.querySelector('.toc-inner');
    let active = null;
    let queued = false;

    const update = () => {
      queued = false;
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      let current = headings[0];
      for (const h of headings) {
        if (h.getBoundingClientRect().top > 140) break;
        current = h;
      }
      if (atBottom) current = headings[headings.length - 1];
      const link = tocLinks[headings.indexOf(current)];
      if (link === active) return;
      active?.classList.remove('active');
      link.classList.add('active');
      active = link;
      if (inner && inner.scrollHeight > inner.clientHeight) {
        inner.scrollTop = link.offsetTop - inner.clientHeight / 2;
      }
    };

    addEventListener(
      'scroll',
      () => {
        if (!queued) {
          queued = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }

  document.querySelectorAll('.prose pre').forEach((pre) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code').innerText);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Failed';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    });
    pre.append(button);
  });
})();
