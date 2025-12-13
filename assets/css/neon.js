// assets/js/neon.js — neon flicker + control UI helpers
// 负责：随机霓虹 flicker、提供 window.toggleCyberpunkAnimations() 以在运行时开/关效果
(function(){
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = !prefersReduced;

  function randomFlicker(){
    if(!enabled) return;
    const elems = Array.from(document.querySelectorAll('.neon-flicker'));
    if(!elems.length) return;
    const el = elems[Math.floor(Math.random()*elems.length)];
    el.classList.add('flicker');
    setTimeout(()=> el.classList.remove('flicker'), 80 + Math.random()*220);
    setTimeout(randomFlicker, 700 + Math.random()*1400);
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    if(enabled) setTimeout(randomFlicker, 800);
  });

  // API to toggle animations at runtime (useful for debugging / accessibility)
  window.toggleCyberpunkAnimations = function(force){
    if(typeof force === 'boolean') enabled = force;
    else enabled = !enabled;
    // enable/disable particles canvas via id
    const canvas = document.getElementById('particles-canvas');
    if(canvas){
      canvas.style.display = enabled ? 'block' : 'none';
    }
    // reduce HUD opacity when disabled
    const hud = document.querySelector('.hud');
    if(hud){
      hud.style.opacity = enabled ? '' : '0.06';
    }
  };

  // expose current state
  window.cyberpunkAnimationsEnabled = () => enabled;
})();
