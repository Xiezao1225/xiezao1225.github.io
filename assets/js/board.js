/* ============================================================================
 * 神人工业 · 状态看板渲染器
 * ----------------------------------------------------------------------------
 * 纯前端展示组件：把一条状态记录渲染成看板。
 *   - status.html（公开页）只读展示，只调用 render()
 *   - admin.html（后台）用它做实时预览，改一个字立刻跟着变
 *
 * 页面用法：
 *   <div data-sr-board></div>
 *   SRBoard.mount(document.querySelector('[data-sr-board]'));
 *   SRBoard.render(record);
 *
 * 依赖：tokens.css + board.css + status.core.js
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------------------------------------------------------- 状态元数据 */

  var STATES = {
    alive:   { zh: '活着',   en: 'ALIVE',   color: '#00ff88', avail: 5 },
    free:    { zh: '有空',   en: 'FREE',    color: '#00f2ff', avail: 5 },
    busy:    { zh: '忙',     en: 'BUSY',    color: '#ffd23f', avail: 2 },
    sleep:   { zh: '睡了',   en: 'SLEEP',   color: '#b06bff', avail: 1 },
    offline: { zh: '没上线', en: 'OFFLINE', color: '#6b7684', avail: 0 }
  };

  var AVAIL = {
    open:    { zh: '可以来打扰',     bars: 5 },
    private: { zh: '看情况，别太急', bars: 3 },
    dnd:     { zh: '别来，真的',     bars: 1 }
  };

  var MEDIA_KIND = { game: '🎮', music: '🎵', video: '📺', none: '' };

  /* 后台的"快捷状态"按钮也用这套元数据，避免两处各写一份 */
  var QUICK = [
    { label: '在线可聊', state: 'alive',   avail: 'open',    activity: '在线，随时可聊',       mood: '' },
    { label: '写代码勿扰', state: 'busy',  avail: 'dnd',     activity: '正在写代码，勿扰',     mood: '别催，快了' },
    { label: '摸鱼',     state: 'free',    avail: 'open',    activity: '摸鱼中，来个人一起玩', mood: '' },
    { label: '睡了',     state: 'sleep',   avail: 'dnd',     activity: '睡了',                 mood: '有事留言，明天看' },
    { label: '下线',     state: 'offline', avail: 'private', activity: '',                     mood: '' }
  ];

  /* ------------------------------------------------------------- 模板 */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tpl() {
    return '' +
    '<div class="board-inner">' +
      '<div class="who">' +
        '<div class="who-av"><img data-b="avatar" src="" alt="" width="66" height="66"></div>' +
        '<div class="who-txt">' +
          '<h1 data-b="name">———</h1>' +
          '<p data-b="title">———</p>' +
        '</div>' +
        '<div class="who-meta">' +
          '<div class="upd">上次更新 <b data-b="updatedRel">———</b></div>' +
          '<div class="abs" data-b="updatedAbs"></div>' +
        '</div>' +
      '</div>' +
      '<div class="state-row">' +
        '<div class="state-badge">' +
          '<span class="beacon" aria-hidden="true"><i></i></span>' +
          '<span><b data-b="stateText">读取中</b><span data-b="stateEn">LOADING</span></span>' +
        '</div>' +
        '<span class="stale-flag" data-b="staleFlag">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16h.01"/>' +
          '<circle cx="12" cy="12" r="9"/></svg>' +
          '<span data-b="staleText">这条状态已经放了一段时间了</span>' +
        '</span>' +
      '</div>' +
      '<div class="avail">' +
        '<div class="avail-head"><span>可打扰程度 · AVAILABILITY</span><b data-b="availText">———</b></div>' +
        '<div class="avail-track" data-b="availTrack" aria-hidden="true"></div>' +
      '</div>' +
      '<dl class="grid">' +
        '<div class="cell wide">' +
          '<dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M3 20h4M4 20V8l8-5 8 5v12"/></svg>当前在做什么</dt>' +
          '<dd data-b="activity" class="skeleton">读取中</dd>' +
        '</div>' +
        '<div class="cell mood">' +
          '<dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 10h.01M15 10h.01M8 15a5 5 0 0 0 8 0"/>' +
          '<circle cx="12" cy="12" r="9"/></svg>心情 / 一句话</dt>' +
          '<dd data-b="mood" class="skeleton">读取中</dd>' +
        '</div>' +
        '<div class="cell">' +
          '<dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v10H4z"/><path d="M8 20h8"/></svg>最近在玩 / 在听</dt>' +
          '<dd data-b="media" class="skeleton">读取中</dd>' +
        '</div>' +
      '</dl>' +
    '</div>';
  }

  /* ------------------------------------------------------------ 实例 */

  function create(el, opts) {
    opts = opts || {};
    el.dataset.srMounted = '1';   /* 标记已挂载，防止自动挂载重复执行 */
    el.classList.add('board');
    if (opts.compact) el.classList.add('compact');
    if (opts.live) el.setAttribute('aria-live', 'polite');
    el.innerHTML = tpl();

    var ref = {};
    Array.prototype.forEach.call(el.querySelectorAll('[data-b]'), function (n) {
      ref[n.getAttribute('data-b')] = n;
    });
    /* 可打扰程度的 5 格只建一次 */
    for (var i = 0; i < 5; i++) ref.availTrack.appendChild(document.createElement('i'));

    var inst = { el: el, ref: ref, opts: opts };
    return inst;
  }

  function setField(node, value, fallback) {
    node.classList.remove('skeleton');
    var v = String(value == null ? '' : value).trim();
    if (v) {
      node.textContent = v;
      node.classList.remove('empty');
    } else {
      node.textContent = fallback == null ? '未填写' : fallback;
      node.classList.add('empty');
    }
  }

  /* 渲染一条记录。opts.relative / opts.absolute 允许调用方自己控制时间显示 */
  function render(inst, rec, opts) {
    opts = opts || {};
    var ref = inst.ref;
    rec = rec || {};
    var meta = STATES[rec.state] || STATES.offline;

    /* 强调色钉在组件自己身上：既能覆盖 :root 的全局值供公开页用，
       又天然被限制在组件内，后台预览不会让编辑区的按钮跟着状态变色。
       （isolate 选项因此不再是必需的，保留是为了向后兼容。） */
    inst.el.style.setProperty('--state', meta.color);

    ref.stateText.textContent = meta.zh;
    ref.stateEn.textContent = meta.en + ' · ' + String(rec.state || 'offline').toUpperCase();

    var am = AVAIL[rec.availability] || AVAIL.private;
    ref.availText.textContent = am.zh;
    var bars = ref.availTrack.querySelectorAll('i');
    for (var j = 0; j < bars.length; j++) {
      bars[j].classList.toggle('on', j < am.bars);
    }

    setField(ref.activity, rec.activity, '他没写自己在干嘛');
    setField(ref.mood, rec.mood, '没留话');

    if (rec.media && rec.media.kind !== 'none' && rec.media.title) {
      var icon = MEDIA_KIND[rec.media.kind] || '•';
      ref.media.classList.remove('empty');
      ref.media.textContent = icon + ' ' + rec.media.title +
        (rec.media.detail ? ' —— ' + rec.media.detail : '');
    } else {
      ref.media.textContent = '暂时没有';
      ref.media.classList.add('empty');
    }

    /* 时间 */
    ref.updatedRel.textContent = opts.relative || '未知';
    ref.updatedAbs.textContent = opts.absolute || '';
    ref.staleFlag.classList.toggle('show', !!opts.stale);
    if (opts.staleText) ref.staleText.textContent = opts.staleText;

    /* 身份信息（展示用，来自配置） */
    var o = (window.SRStatus && window.SRStatus.config && window.SRStatus.config.owner) || {};
    if (o.name) ref.name.textContent = o.name;
    if (o.title) ref.title.textContent = o.title + (o.handle ? ' · ' + o.handle : '');
    if (o.avatar && ref.avatar.getAttribute('src') !== o.avatar) {
      ref.avatar.src = o.avatar;
      ref.avatar.alt = (o.name || '') + ' 的头像';
    }
  }

  /* 便捷方法：按当前记录算出时间文案再渲染 */
  function renderRecord(inst, rec) {
    rec = rec || {};
    var S = window.SRStatus;
    var rel = S && rec.updatedAt ? S.relativeTime(rec.updatedAt) : '未知';
    var abs = S && rec.updatedAt ? S.absoluteTime(rec.updatedAt) : '';
    var stale = false;
    if (rec.updatedAt) {
      var mins = (Date.now() - Date.parse(rec.updatedAt)) / 60000;
      var limit = (S && S.config && S.config.staleAfterMinutes) || 180;
      stale = !isNaN(mins) && mins > limit;
    }
    render(inst, rec, { relative: rel, absolute: abs, stale: stale });
  }

  window.SRBoard = {
    STATES: STATES,
    AVAIL: AVAIL,
    QUICK: QUICK,
    MEDIA_KIND: MEDIA_KIND,
    esc: esc,
    mount: function (el, opts) { return create(el, opts); },
    render: render,
    renderRecord: renderRecord
  };

  /* 兼容性：页面里直接写了 <div data-sr-board> 的，自动挂载 */
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-sr-board]'), function (el) {
      if (!el.dataset.srMounted) {
        el.dataset.srMounted = '1';
        create(el, { compact: el.hasAttribute('data-compact'), live: el.hasAttribute('data-live') });
      }
    });
  });
})();
