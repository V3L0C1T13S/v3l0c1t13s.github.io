(function () {
  const nav = document.querySelector('.post-sections');
  const headings = Array.from(document.querySelectorAll('.post .prose h2, .post .prose h3'));
  if (!nav || !headings.length) return;

  const list = nav.querySelector('ol');
  const links = headings.map((heading, index) => {
    if (!heading.id) {
      let id = 'post-section-' + (index + 1);
      while (document.getElementById(id)) id += '-section';
      heading.id = id;
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#' + encodeURIComponent(heading.id);
    link.textContent = heading.textContent;
    if (heading.tagName === 'H3') item.className = 'post-sections__subsection';
    item.appendChild(link);
    list.appendChild(item);
    return link;
  });
  nav.hidden = false;
  nav.closest('.post-layout').classList.add('post-layout--sections');

  let positions = [];
  let active = -1;
  function measure() {
    positions = headings.map(heading => heading.getBoundingClientRect().top + window.scrollY);
    updateCurrent();
  }
  function updateCurrent() {
    let current = 0;
    const boundary = window.scrollY + 120;
    positions.forEach((top, index) => {
      if (top <= boundary) current = index;
    });
    if (current === active) return;
    if (active >= 0) links[active].removeAttribute('aria-current');
    links[current].setAttribute('aria-current', 'location');
    active = current;
  }
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { updateCurrent(); scheduled = false; });
  }, { passive: true });
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);
  // Images, fonts, and responsive wrapping can move headings after first paint.
  if ('ResizeObserver' in window) {
    new ResizeObserver(measure).observe(document.querySelector('.post'));
  }
  measure();
})();
