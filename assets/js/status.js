/* ============================================================================
 * 神人工业 · 公开状态页逻辑
 * ----------------------------------------------------------------------------
 * 这一页是给别人看的，只有"读"的能力：
 *   - 从后端读当前状态
 *   - 订阅变更（Realtime 推送 / 降级轮询）
 *   - 每 30 秒刷新一次"上次更新 N 分钟前"
 * 它没有任何写入路径，也不含登录代码。编辑去 admin.html。
 * ==========================================================================*/
(function () {
  'use strict';

  var S = window.SRStatus;
  var UI = window.SRUI;
  var B = window.SRBoard;
  var CFG = S.config;

  var board, errBox, current = null;

  function boot() {
    errBox = document.getElementById('errBox');

    board = B.mount(document.querySelector('[data-sr-board]'), { live: true });

    /* 先把兜底状态画出来，页面不会空着等网络 */
    current = S.normalize(CFG.fallback || {});
    B.renderRecord(board, current);

    load(true);

    /* 相对时间会过期，定时重算；顺便让"过期提示"及时亮起 */
    setInterval(function () {
      if (current) B.renderRecord(board, current);
    }, 30000);
  }

  function load(first) {
    S.read().then(function (rec) {
      current = rec;
      B.renderRecord(board, rec);
      UI.renderIssues(errBox, UI.configIssues());

      if (first && S.adapterName !== 'local') {
        S.subscribe(function (fresh) {
          /* 适配器会推 {_mode:'realtime'|'poll'} 播报当前同步方式 */
          if (fresh && fresh._mode) { UI.setSync(fresh._mode); return; }
          current = fresh;
          B.renderRecord(board, fresh);
        });
      } else if (first) {
        UI.setSync('local');
      }
    }).catch(function (e) {
      UI.setSync(S.adapterName === 'local' ? 'local' : 'poll');
      var hint = '读取云端状态失败：' + e.message
        + '。现在显示的是 assets/js/status.config.js 里的兜底状态。'
        + '如果还没在 Supabase 跑建表 SQL，这是正常的。';
      UI.renderIssues(errBox, UI.configIssues(), hint);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
