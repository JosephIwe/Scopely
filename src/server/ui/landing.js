// Links made before the product moved to /app (for example /#/p/12) still open: the part after the
// hash only ever named an app screen, so it is carried over unchanged.
if (/^#\/./.test(location.hash)) location.replace(`/app${location.hash}`);

// Scroll reveals for the landing page. This runs in the head: it arms the reveal styles
// (html.lp-motion) only when they can be undone, that is when IntersectionObserver exists and the
// reader has not asked for reduced motion. If anything here fails, the class comes off and every
// section stays visible. Nothing runs on a timer; the scroll handler does one write per frame.
(() => {
  const root = document.documentElement;
  const reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
  const motion = 'IntersectionObserver' in window && !reduce.matches;
  if (motion) root.classList.add('lp-motion');

  const arm = () => {
    try {
      const targets = document.querySelectorAll('[data-reveal], [data-stagger]');
      document.querySelectorAll('[data-stagger]').forEach((list) => {
        [...list.children].forEach((el, i) => el.style.setProperty('--i', String(i)));
      });
      const reveal = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          reveal.unobserve(e.target);
        }
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
      targets.forEach((el) => reveal.observe(el));

      // The closing section's background light drifts only while it is on screen.
      const cta = document.querySelector('.lp-cta');
      if (cta) new IntersectionObserver(([e]) => cta.classList.toggle('live', e.isIntersecting)).observe(cta);

      // Turning reduced motion on mid-visit shows everything at once.
      reduce.addEventListener?.('change', (e) => {
        if (!e.matches) return;
        targets.forEach((el) => el.classList.add('is-in'));
        root.classList.remove('lp-motion');
      });
    } catch {
      root.classList.remove('lp-motion');
    }
  };

  const start = () => {
    if (motion) arm();
    // A thin reading-progress line under the header.
    const bar = document.querySelector('.lp-progress i');
    if (bar) {
      let queued = false;
      const paint = () => {
        queued = false;
        const max = document.documentElement.scrollHeight - innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
      };
      const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
      addEventListener('scroll', queue, { passive: true });
      addEventListener('resize', queue, { passive: true });
      paint();
    }
  };

  // iOS Safari applies :active (the pressed state) only once a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
