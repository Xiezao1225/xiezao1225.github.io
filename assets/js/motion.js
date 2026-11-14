/* ============================================================================
 * 神人工业 · 共享动效层（行为）
 * ----------------------------------------------------------------------------
 * 与 assets/css/motion.css 配套。三条自我约束：
 *   1. 元素驱动：页面上有什么就做什么，什么都没有就一行副作用都不产生。
 *   2. 幂等：重复引入、或在同一页执行两次，都不会重复绑定。
 *   3. 只写 CSS 自定义属性（--p / --mx / --my / --rx / --ry / --rd），
 *      绘制全部交给 CSS，避免在 JS 里直接改样式触发布局。
 * ==========================================================================*/
(function(){
  "use strict";
  if(window.__SR_MOTION__) return;
  window.__SR_MOTION__ = true;

  var doc = document;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = window.matchMedia && window.matchMedia("(hover:hover) and (pointer:fine)").matches;

  function $(sel){ return doc.querySelector(sel); }
  function $$(sel, ctx){ return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  /* ================= 1. 页面入场总开关 =================
     有启动动画的页面（index.html）由它自己退场时加 .ready；
     其它页面在这里补上。两帧延迟是必须的：先让浏览器算出初始状态，
     再加类，入场动画才会真的播，而不是被合并掉。 */
  function scheduleReady(){
    if(doc.body && doc.body.classList.contains("ready")) return;
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ if(doc.body) doc.body.classList.add("ready"); });
    });
  }

  /* ================= 2. 滚动揭示 ================= */
  function initReveals(){
    var reveals = $$(".reveal");
    var staggerGroups = $$("[data-stagger]");
    if(!reveals.length && !staggerGroups.length) return;

    /* 同组错峰：写 --rd（只被入场动画消费），不用 transition-delay ——
       后者会把卡片 hover 的过渡一起延迟，手感立刻变黏。 */
    function applyStagger(){
      $$("[data-stagger]").forEach(function(group){
        Array.prototype.forEach.call(group.children, function(child, i){
          child.style.setProperty("--rd", (i * 90) + "ms");
        });
      });
    }
    applyStagger();

    /* 没有 IntersectionObserver、或用户要求减少动效时，直接放到终态 */
    var useIO = ("IntersectionObserver" in window) && !reduce;
    var io = null;
    if(useIO){
      io = new IntersectionObserver(function(entries){
        entries.forEach(function(e){
          if(e.isIntersecting){ e.target.classList.add("in"); io.unobserve(e.target); }
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: .12 });
    }
    function arm(el){
      if(io){ io.observe(el); } else { el.classList.add("in"); }
    }

    reveals.forEach(function(el, i){
      if(!el.style.getPropertyValue("--rd")){
        el.style.setProperty("--rd", ((i % 3) * 60) + "ms");
      }
      arm(el);
    });

    /* 动态内容（状态看板、profile 的筛选重渲染）：渲染完再补观察，
       否则后插入的卡片会一直停在 opacity:0，看起来就是"点筛选没反应" */
    var dynamic = $$("[data-sr-board],[data-stagger]");
    if(dynamic.length && "MutationObserver" in window){
      var mo = new MutationObserver(function(){
        applyStagger();
        dynamic.forEach(function(box){
          $$(".reveal:not(.in)", box).forEach(function(el){
            if(!el.style.getPropertyValue("--rd")) el.style.setProperty("--rd", "0ms");
            arm(el);
          });
        });
      });
      dynamic.forEach(function(box){ mo.observe(box, { childList: true, subtree: true }); });
    }
  }

  /* ================= 3. 数字滚动 ================= */
  function initCounters(){
    var counters = $$("[data-count]");
    if(!counters.length) return;

    function run(el){
      var end = parseInt(el.getAttribute("data-count"), 10) || 0;
      if(reduce){ el.textContent = end.toLocaleString(); return; }
      var t0 = null, dur = 1300;
      function step(ts){
        if(!t0) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur);
        el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))).toLocaleString();
        if(k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    if(!("IntersectionObserver" in window) || reduce){
      counters.forEach(run);
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ run(e.target); io.unobserve(e.target); }
      });
    }, { threshold: .5 });
    counters.forEach(function(el){ io.observe(el); });
  }

  /* ================= 4. 指针跟随：光斑 + 倾斜 =================
     只用事件委托，所以动态渲染出来的卡片也能吃到；
     指针事件用 rAF 合并，一帧最多写一次样式。 */
  function initPointer(){
    if(!fine || reduce) return;

    var SPOT_SEL = "[data-spot],[data-tilt]";
    var TILT_SEL = "[data-tilt]";
    /* 倾斜跨度：卡片中心到边缘的最大角度，16 ≈ ±8°。
       想更夸张就调大它，同时把 CSS 里的 perspective 收小。 */
    var TILT_MAX = 16;
    var hovered = null, pending = null, queued = false;

    function reset(el){
      el.style.removeProperty("--mx");
      el.style.removeProperty("--my");
      el.style.removeProperty("--rx");
      el.style.removeProperty("--ry");
    }

    function apply(){
      queued = false;
      var e = pending;
      if(!e) return;
      var el = e.target && e.target.closest ? e.target.closest(SPOT_SEL) : null;
      if(el !== hovered){
        if(hovered) reset(hovered);
        hovered = el;
      }
      if(!el) return;
      var r = el.getBoundingClientRect();
      if(!r.width || !r.height) return;
      var x = e.clientX - r.left, y = e.clientY - r.top;
      el.style.setProperty("--mx", x.toFixed(1) + "px");
      el.style.setProperty("--my", y.toFixed(1) + "px");
      if(el.matches(TILT_SEL)){
        el.style.setProperty("--ry", ((x / r.width - .5) * TILT_MAX).toFixed(2) + "deg");
        el.style.setProperty("--rx", ((.5 - y / r.height) * TILT_MAX).toFixed(2) + "deg");
      }
    }

    doc.addEventListener("pointermove", function(e){
      pending = e;
      if(!queued){ queued = true; requestAnimationFrame(apply); }
    }, { passive: true });

    doc.addEventListener("pointerout", function(e){
      var el = e.target && e.target.closest ? e.target.closest(SPOT_SEL) : null;
      if(el && (!e.relatedTarget || !el.contains(e.relatedTarget))) reset(el);
    }, true);
  }

  /* ================= 5. 滚动联动 ================= */
  function initScroll(){
    var bar = $(".sr-progress");
    var head = $(".site-head");
    var heroInner = $(".hero-inner");
    var hint = $(".scroll-hint");
    if(!bar && !head && !heroInner && !hint) return;

    var queued = false;
    function apply(){
      queued = false;
      var y = window.scrollY || doc.documentElement.scrollTop;
      var max = Math.max(1, doc.documentElement.scrollHeight - window.innerHeight);

      if(bar){
        var k = Math.min(1, y / max);
        bar.style.setProperty("--p", k.toFixed(4));
        bar.classList.toggle("on", k > .002);
      }
      if(head) head.classList.toggle("stuck", y > 8);
      if(heroInner){
        var vh = window.innerHeight || 1;
        var hp = Math.max(0, Math.min(1, y / (vh * .9)));
        heroInner.style.setProperty("--hero-y", (hp * 46).toFixed(1) + "px");
        heroInner.style.setProperty("--hero-o", (1 - hp * .6).toFixed(3));
      }
      if(hint) hint.style.setProperty("--hint-o", Math.max(0, 1 - y / 240).toFixed(3));
    }
    function onScroll(){
      if(queued) return;
      queued = true;
      requestAnimationFrame(apply);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    apply();
  }

  /* ================= 6. 汉堡菜单（页头抽屉） =================
     全站共用一份行为：首页、人物档案等都有同一套 #menu + #burger。
     用事件委托，不逐条链接绑定。 */
  function initMenu(){
    var menu = doc.getElementById("menu");
    var burger = doc.getElementById("burger");
    if(!menu || !burger) return;

    function setOpen(open){
      menu.classList.toggle("open", open);
      burger.classList.toggle("on", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    burger.addEventListener("click", function(){
      setOpen(!menu.classList.contains("open"));
    });
    /* 点了导航项就收起 */
    menu.addEventListener("click", function(e){
      if(e.target && e.target.closest && e.target.closest("a")) setOpen(false);
    });
    /* Esc 收起 */
    doc.addEventListener("keydown", function(e){
      if(e.key === "Escape" && menu.classList.contains("open")) setOpen(false);
    });
  }

  /* ================= 7. 页面转场遮罩（神） =================
     进站那半场是纯 CSS 动画，没有 JS 也能播；
     这里只负责离站：拦住站内链接，先让遮罩盖上（约 420ms），再跳转。 */
  function initVeil(){
    var veil = $(".sr-veil");
    if(!veil || reduce) return;
    var leaving = false;
    /* 入场动画（1s）没演完就点链接的话，.cover 会从 opacity:0 重新起跑，
       黑屏会先闪一下再浮现。这种情况下直接跳转，不做转场。 */
    var now = function(){ return (window.performance && performance.now) ? performance.now() : Date.now(); };
    var readyAt = now() + 1100;

    doc.addEventListener("click", function(e){
      if(leaving || e.defaultPrevented) return;
      /* 这些情况交给浏览器自己处理：新标签、下载、外链、页内锚点、非普通左键 */
      if(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if(!a) return;
      if(a.target && a.target !== "_self") return;
      if(a.hasAttribute("download")) return;

      var href = a.getAttribute("href") || "";
      if(href.charAt(0) === "#") return;
      var proto = a.protocol;
      if(proto !== "http:" && proto !== "https:" && proto !== "file:") return;
      /* file:// 打开时 host 都是空串，不做跨域判断 */
      if(proto !== "file:" && a.host !== location.host) return;

      if(now() < readyAt) return;   /* 入场还没演完：交给浏览器直接跳 */

      leaving = true;
      e.preventDefault();
      veil.classList.add("cover");
      /* 等黑屏合拢、神字填白（与 motion.css 的 .9s 对齐）再跳转，
         让两个半场在同一帧上交接 */
      setTimeout(function(){ location.href = a.href; }, 900);
    });
  }

  /* ================= 启动 ================= */
  function boot(){
    initReveals();
    initCounters();
    initPointer();
    initScroll();
    initMenu();
    initVeil();
    /* 带启动动画的页面自己决定什么时候 ready；这里不要抢跑 */
    if(!doc.getElementById("loader")) scheduleReady();
  }

  /* 有神字遮罩的页面（且不是首页那种启动动画页）：把入场整体推迟到黑屏
     开始退去的那一刻（遮罩在 38% × 1s ≈ 380ms 后开始淡出），否则
     .reveal / main 的入场会在黑屏后面演完，揭开时已经是静止画面。 */
  function start(){
    if($(".sr-veil") && !doc.getElementById("loader")){ setTimeout(boot, 400); }
    else{ boot(); }
  }

  if(doc.readyState === "loading"){ doc.addEventListener("DOMContentLoaded", start); }
  else{ start(); }

  /* 页面上如果有异步改内容的地方，可以派发 sr:motion-refresh 让动效重新对齐 */
  doc.addEventListener("sr:motion-refresh", function(){
    initReveals();
    initCounters();
  });
})();
