/* Drives the fast-imports diagram one step at a time: a dart crosses the wire,
   the node it lands on pops in, and the sequence then holds long enough to read
   the step before moving on. With JS off, or with reduced motion asked for, the
   diagram is simply left in its finished state. */
(function () {
  var figures = document.querySelectorAll('.import-viz');
  if (!figures.length) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var POP  = 360;   /* node settling into place    */
  var HOLD = 900;   /* pause to read the new step  */
  var LOOP = 2200;  /* rest on the finished diagram before replaying */

  Array.prototype.forEach.call(figures, function (fig) { init(fig); });

  function init(fig) {
    var steps = Array.prototype.slice.call(fig.querySelectorAll('.iv-step'));
    if (!steps.length) return;

    var dots = fig.querySelector('.import-viz__dots');
    var status = fig.querySelector('.import-viz__status');
    var toggle = fig.querySelector('[data-act="toggle"]');
    var replay = fig.querySelector('[data-act="replay"]');
    var region = fig.querySelector('.iv-region');

    var count = null, note = null;
    if (status) {
      count = document.createElement('span');
      count.className = 'import-viz__count';
      note = document.createElement('span');
      status.appendChild(count);
      status.appendChild(note);
    }

    /* Each dart is timed from the length it actually has to cover, so a 34-unit
       wire and the long return trip read as the same gesture at the same speed
       rather than one crawling and the other jumping. */
    steps.forEach(function (step) {
      var dart = step.querySelector('.iv-dart');
      if (!dart) return;
      step.classList.add('has-wire');
      var len = dart.getTotalLength();
      var travel = Math.min(900, Math.max(300, Math.round(len * 1.4)));
      dart.style.setProperty('--len', len.toFixed(1));
      step.style.setProperty('--travel', travel + 'ms');
      step.dataset.travel = travel;
      step.dataset.len = len;
    });

    var buttons = steps.map(function (step, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'import-viz__dot';
      b.title = 'Step ' + (i + 1) + ' of ' + steps.length;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', function () { jumpTo(i); });
      if (dots) dots.appendChild(b);
      return b;
    });

    fig.classList.add('is-animated');
    sizeRegion(-1, true);

    var index = -1;         /* last revealed step */
    var elapsed = 0;        /* time spent on the current step */
    var paused = false;     /* user-requested pause */
    var offscreen = true;   /* not worth animating out of view */
    var last = 0;
    var running = false;

    /* The dashed compiled region wraps what is on screen now, not what will
       eventually be there, so it widens as the lane fills in. */
    function sizeRegion(upTo, instant) {
      if (!region) return;
      var width = null;
      for (var j = 0; j <= upTo && j < steps.length; j++) {
        if (steps[j].dataset.region) width = steps[j].dataset.region;
      }
      if (width === null) {
        for (var k = 0; k < steps.length && width === null; k++) {
          if (steps[k].dataset.region) width = steps[k].dataset.region;
        }
      }
      if (width === null) return;
      if (instant) {
        region.style.transition = 'none';
        region.setAttribute('width', width);
        void region.getBoundingClientRect();
        region.style.transition = '';
      } else {
        region.setAttribute('width', width);
      }
    }

    function duration(i) {
      if (i < 0) return 0;
      var travel = parseInt(steps[i].dataset.travel, 10) || 90;
      var base = travel + POP + HOLD;
      return i === steps.length - 1 ? base + LOOP : base;
    }

    /* Sending the dart down the wire. This is done here rather than in CSS
       because the end offset is the path's own length: a keyframe of
       calc(-1 * var(--len)) is not interpolable, so the dart would sit still
       and then jump to the far end instead of travelling. */
    function sendDart(step) {
      var dart = step.querySelector('.iv-dart');
      if (!dart || !dart.animate) return;
      var len = parseFloat(step.dataset.len);
      var travel = parseInt(step.dataset.travel, 10);
      var dash = parseFloat(getComputedStyle(dart).getPropertyValue('--dart')) || 26;
      dart.getAnimations().forEach(function (a) { a.cancel(); });
      dart.animate(
        [{ strokeDashoffset: dash }, { strokeDashoffset: -len }],
        { duration: travel, easing: 'cubic-bezier(0.5, 0.02, 0.42, 1)', fill: 'forwards' }
      );
      dart.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.86 }, { opacity: 0 }],
        { duration: travel, easing: 'linear', fill: 'forwards' }
      );
    }

    function reveal(i, instant) {
      var step = steps[i];
      step.classList.toggle('is-instant', !!instant);
      /* Restart the CSS animations even if the class is already present. */
      step.classList.remove('is-live');
      void step.getBoundingClientRect();
      step.classList.add('is-live');
      if (!instant) sendDart(step);
      steps.forEach(function (s) { s.classList.remove('is-current'); });
      step.classList.add('is-current');
      sizeRegion(i, !!instant);
      if (status) {
        count.textContent = pad(i + 1) + ' / ' + pad(steps.length);
        note.textContent = step.dataset.label || '';
      }
      buttons.forEach(function (b, j) {
        b.classList.toggle('is-current', j === i);
        b.classList.toggle('is-done', j < i);
      });
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function clear() {
      steps.forEach(function (s) {
        s.classList.remove('is-live', 'is-current', 'is-instant');
        var dart = s.querySelector('.iv-dart');
        if (dart && dart.getAnimations) dart.getAnimations().forEach(function (a) { a.cancel(); });
      });
      buttons.forEach(function (b) { b.classList.remove('is-current', 'is-done'); });
      sizeRegion(-1, true);
      index = -1;
      elapsed = 0;
    }

    function advance() {
      if (index >= steps.length - 1) {
        clear();
        if (status) { count.textContent = ''; note.textContent = ''; }
      }
      index += 1;
      elapsed = 0;
      reveal(index, false);
    }

    function jumpTo(i) {
      clear();
      for (var j = 0; j < i; j++) {
        steps[j].classList.add('is-live', 'is-instant');
        buttons[j].classList.add('is-done');
      }
      index = i;
      elapsed = 0;
      sizeRegion(i - 1, true);
      reveal(i, false);
      setPaused(true);
    }

    function setPaused(next) {
      paused = next;
      if (toggle) {
        toggle.textContent = paused ? 'Play' : 'Pause';
        toggle.setAttribute('aria-pressed', String(paused));
      }
      if (!paused) start();
    }

    function frame(now) {
      if (!running) return;
      var dt = Math.min(now - last, 120);
      last = now;
      if (paused || offscreen || document.hidden) {
        running = false;
        return;
      }
      elapsed += dt;
      if (elapsed >= duration(index)) advance();
      requestAnimationFrame(frame);
    }

    function start() {
      if (running || paused || offscreen || document.hidden) return;
      running = true;
      last = performance.now();
      if (index < 0) advance();
      requestAnimationFrame(frame);
    }

    if (toggle) toggle.addEventListener('click', function () { setPaused(!paused); });
    if (replay) replay.addEventListener('click', function () {
      clear();
      paused = false;
      if (toggle) { toggle.textContent = 'Pause'; toggle.setAttribute('aria-pressed', 'false'); }
      start();
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) start(); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        offscreen = !entries[0].isIntersecting;
        if (!offscreen) start(); else running = false;
      }, { threshold: 0.25 }).observe(fig);
    } else {
      offscreen = false;
      start();
    }
  }
})();
