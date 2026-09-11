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

  function updateCurrent() {
    let current = 0;
    headings.forEach((heading, index) => {
      if (heading.getBoundingClientRect().top <= 120) current = index;
    });
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { updateCurrent(); scheduled = false; });
  }, { passive: true });
  window.addEventListener('resize', updateCurrent);
  updateCurrent();
})();
