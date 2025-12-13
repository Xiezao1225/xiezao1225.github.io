// assets/js/neon.js — small neon flicker helper
document.addEventListener('DOMContentLoaded', ()=> {
  // optional: add subtle random flicker to elements with .neon-flicker
  const flickers = Array.from(document.querySelectorAll('.neon-flicker'));
  if(!flickers.length) return;
  function flick(){
    const el = flickers[Math.floor(Math.random()*flickers.length)];
    el.classList.add('flicker');
    setTimeout(()=> el.classList.remove('flicker'), 80 + Math.random()*240);
    setTimeout(flick, 800 + Math.random()*1600);
  }
  setTimeout(flick, 1200);
});
/* CSS hook: .flicker can be handled by CSS (small brightness change) */
