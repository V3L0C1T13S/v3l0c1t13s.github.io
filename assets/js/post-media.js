/* Preserve inline autoplay while avoiding downloads and decoding offscreen. */
(function () {
  document.querySelectorAll('video[data-autoplay]').forEach(function (video) {
    var visible = false;

    function update() {
      if (!visible || document.hidden) {
        video.pause();
        return;
      }
      var playing = video.play();
      if (playing) playing.catch(function () {
        // If autoplay is unavailable, keep the demo accessible.
        video.controls = true;
      });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        update();
      }).observe(video);
    } else {
      visible = true;
      update();
    }
    document.addEventListener('visibilitychange', update);
  });
})();
