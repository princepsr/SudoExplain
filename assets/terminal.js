// Fits the About-page terminal to the window. When the whole terminal would be taller than the space
// left under the header, the least important lines are hidden (data-drop 1 first) until it fits, so no
// line is ever cut off. Runs on load and whenever the window is resized. No dependencies.
(() => {
  const wrap = document.querySelector('.terminal-wrap');
  const terminal = wrap?.querySelector('.terminal');
  if (!terminal) return;

  const droppable = [...terminal.querySelectorAll('[data-drop]')].sort((a, b) => a.dataset.drop - b.dataset.drop);

  const fit = () => {
    droppable.forEach((el) => {
      el.hidden = false;
    });

    // Below the text (tablets) or hidden (phones) there is nothing to fit, so show every line.
    if (getComputedStyle(wrap).position !== 'sticky' || !wrap.offsetParent) return;

    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const available = innerHeight - parseFloat(getComputedStyle(wrap).top) - 1.5 * rem;

    terminal.style.maxHeight = 'none';
    for (const el of droppable) {
      if (terminal.getBoundingClientRect().height <= available) break;
      el.hidden = true;
    }
    terminal.style.maxHeight = '';
  };

  let timer = 0;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(fit, 100);
  });
  fit();
})();
