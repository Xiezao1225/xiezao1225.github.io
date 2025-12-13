// assets/js/particles.js — lightweight neon particle network on canvas
// Features: neon particles, glow, mouse interaction, respects prefers-reduced-motion
(function(){
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(prefersReduced) return; // don't run heavy animation

  let canvas, ctx, width, height, particles = [], pointer = {x:-9999,y:-9999,down:false};
  const config = {
    countFactor: 0.0009, // particles per px^2
    maxSpeed: 0.6,
    maxRadius: 2.6,
    lineDistance: 120,
    colors: ['#00f0ff','#ff00d0','#ffd400']
  };

  function init(){
    canvas = document.getElementById('particles-canvas');
    if(!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', e => { pointer.x = e.clientX; pointer.y = e.clientY; });
    window.addEventListener('mouseout', ()=> { pointer.x = -9999; pointer.y = -9999; });
    window.addEventListener('mousedown', ()=> pointer.down = true);
    window.addEventListener('mouseup', ()=> pointer.down = false);
    spawnParticles();
    requestAnimationFrame(loop);
  }

  function resize(){
    width = canvas.width = Math.max(1, innerWidth);
    height = canvas.height = Math.max(1, innerHeight);
    // regenerate if count changes a lot
    const target = Math.floor(width * height * config.countFactor);
    if(particles.length === 0 || Math.abs(particles.length - target) > 10) {
      particles = [];
      for(let i=0;i<target;i++) particles.push(createParticle());
    }
  }

  function createParticle(){
    return {
      x: Math.random()*width,
      y: Math.random()*height,
      vx: (Math.random()-0.5) * config.maxSpeed,
      vy: (Math.random()-0.5) * config.maxSpeed,
      r: 0.6 + Math.random() * config.maxRadius,
      color: config.colors[Math.floor(Math.random()*config.colors.length)]
    };
  }

  function spawnParticles(){
    const target = Math.floor(width * height * config.countFactor);
    while(particles.length < target) particles.push(createParticle());
    while(particles.length > target) particles.pop();
  }

  function loop(){
    ctx.clearRect(0,0,width,height);
    ctx.globalCompositeOperation = 'lighter';
    // draw particles
    for(let i=0;i<particles.length;i++){
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      // wrap
      if(p.x < -10) p.x = width + 10;
      if(p.x > width + 10) p.x = -10;
      if(p.y < -10) p.y = height + 10;
      if(p.y > height + 10) p.y = -10;

      // mouse interaction: gentle attraction when near
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const d2 = dx*dx + dy*dy;
      if(d2 < 16000){ // within 126px
        const dist = Math.sqrt(d2) || 1;
        const force = (pointer.down ? 0.9 : 0.4) * (1 - dist/140);
        p.vx += (dx/dist) * 0.02 * force;
        p.vy += (dy/dist) * 0.02 * force;
      }

      // small damping
      p.vx *= 0.995;
      p.vy *= 0.995;

      // draw glow
      ctx.beginPath();
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r*6);
      gradient.addColorStop(0, p.color);
      gradient.addColorStop(0.2, p.color + '66');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.arc(p.x, p.y, p.r*6, 0, Math.PI*2);
      ctx.fill();

      // small core
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fill();
    }

    // draw connecting lines
    for(let i=0;i<particles.length;i++){
      for(let j=i+1;j<particles.length;j++){
        const a = particles[i], b = particles[j];
        const dx = a.x-b.x, dy = a.y-b.y;
        const dist = Math.sqrt(dx*dx+dy*dy);
        if(dist < config.lineDistance){
          const alpha = 1 - (dist / config.lineDistance);
          ctx.strokeStyle = mixColor(a.color, b.color, 0.5).replace(')', `,${(alpha*0.12).toFixed(3)})`).replace('rgb','rgba');
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x,a.y);
          ctx.lineTo(b.x,b.y);
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(loop);
  }

  // helper: mix two hex colors roughly into rgb string
  function mixColor(hex1,hex2,ratio){
    function hexToRgb(h){
      h=h.replace('#','');
      return [parseInt(h.substring(0,2),16),parseInt(h.substring(2,4),16),parseInt(h.substring(4,6),16)];
    }
    const a = hexToRgb(hex1), b = hexToRgb(hex2);
    const r = Math.round(a[0]*(1-ratio)+b[0]*ratio);
    const g = Math.round(a[1]*(1-ratio)+b[1]*ratio);
    const bl = Math.round(a[2]*(1-ratio)+b[2]*ratio);
    return `rgb(${r},${g},${bl})`;
  }

  // init when DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
