/* ============================================================================
 * 神人工业 · 小工具
 * ----------------------------------------------------------------------------
 * 公开页和后台都要用的零碎东西，集中在这里，避免两边各写一份慢慢走样。
 * 依赖：status.core.js
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------------------------- 同步方式徽标 */

  var el = {};

  function pick() {
    el.chip = document.getElementById('liveChip');
    el.dot = document.getElementById('liveDot');
    el.txt = document.getElementById('liveTxt');
  }

  /* mode: 'realtime' | 'poll' | 'local' */
  function setSync(mode) {
    if (!el.chip) pick();
    if (!el.dot) return;
    el.dot.className = mode === 'realtime' ? 'on' : (mode === 'poll' ? 'poll' : '');
    if (el.txt) {
      el.txt.textContent =
        mode === 'realtime' ? '实时同步中' :
        mode === 'poll' ? '轮询同步中' : '本地模式';
    }
    if (el.chip) {
      el.chip.title = mode === 'realtime'
        ? '数据由 Realtime 推送驱动，你在别处改完这里会立刻变'
        : (mode === 'poll' ? 'Realtime 不可用，已降级为定时轮询（约 20 秒一次）'
                           : '未接后端，状态来自 assets/js/status.config.js');
    }
  }

  /* 默认同步方式：谁都别忘了调，页面自己就会给出一个确定值。
     以前这个职责散落在各页的 boot() 里，admin.js 漏了 —— 于是徽标永远停在
     HTML 里写死的"正在连接…"。现在改成由本模块自动落地，杜绝这类漏调。 */
  function defaultMode() {
    var S = window.SRStatus;
    if (!S || !S.adapterName || S.adapterName === 'local') return 'local';
    return 'poll';   /* 有后端就先按轮询显示；Realtime 连上会再升级成 realtime */
  }

  function autoInit() {
    pick();
    setSync(defaultMode());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  /* ------------------------------------------------- 错误 / 提示条 */

  function showNotice(box, html) {
    if (!box) return;
    box.style.display = '';
    box.innerHTML = html;
  }

  function hideNotice(box) {
    if (!box) return;
    box.style.display = 'none';
    box.innerHTML = '';
  }

  /* 把一坨 {level,text} 配置问题渲染成一个 div 列表 */
  function renderIssues(box, issues, extra) {
    var lines = [];
    (issues || []).forEach(function (it) {
      if (!it || it.level === 'info') return;
      lines.push((it.level === 'error' ? '⛔ ' : '⚠️ ') + it.text);
    });
    if (extra) lines.push('ℹ️ ' + extra);

    if (!lines.length) { hideNotice(box); return; }

    var holder = document.createElement('div');
    var svg = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/></svg>';
    var wrap = document.createElement('div');
    wrap.innerHTML = svg;
    wrap.appendChild(buildLines(lines));
    holder.appendChild(wrap);

    box.style.display = '';
    box.className = 'notice ' + (lines.some(function (l) { return l.charAt(0) === '⛔'; }) ? 'err' : 'warn');
    box.innerHTML = '';
    while (wrap.firstChild) box.appendChild(wrap.firstChild);
  }

  function buildLines(lines) {
    var span = document.createElement('span');
    lines.forEach(function (l, i) {
      if (i) span.appendChild(document.createElement('br'));
      span.appendChild(document.createTextNode(l));
    });
    return span;
  }

  /* ------------------------------------------------- 配置自检 */

  function configIssues() {
    return (window.SRStatus && window.SRStatus.configIssues)
      ? window.SRStatus.configIssues() : [];
  }

  window.SRUI = {
    setSync: setSync,
    showNotice: showNotice,
    hideNotice: hideNotice,
    renderIssues: renderIssues,
    configIssues: configIssues
  };
})();
