(function () {
  const nav = document.querySelector('.post-sections');
  const headings = Array.from(document.querySelectorAll('.post .prose h2, .post .prose h3'));
  if (!nav || !headings.length) return;

  const list = nav.querySelector('ol');
  const toggle = nav.querySelector('.post-sections__toggle');
  const mobile = window.matchMedia('(max-width: 34rem)');
  let expanded = false;
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
  // The nav column and its space are already reserved by the server-rendered
  // layout class, so this only mirrors the expanded state for mobile.
  function syncSections() {
    nav.classList.toggle('post-sections--expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('span').textContent = expanded ? '−' : '+';
    measure();
  }
  toggle.addEventListener('click', () => { expanded = !expanded; syncSections(); });
  list.addEventListener('click', event => {
    if (!mobile.matches || !event.target.closest('a')) return;
    expanded = false;
    syncSections();
  });
  mobile.addEventListener('change', syncSections);
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (mobile.matches && !expanded) return;
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
  syncSections();
})();
