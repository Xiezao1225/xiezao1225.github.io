/* ============================================================================
 * 神人工业 · 后台管理页逻辑
 * ----------------------------------------------------------------------------
 * 这一页只有你本人用：登录、改状态、实时预览、保存。
 * 权限不靠"藏起来"，靠 Supabase 的 RLS 策略核对邮箱 —— 别人打开这页也改不动。
 * 依赖：status.core.js + ui.js + board.js
 * ==========================================================================*/
(function () {
  'use strict';

  var S = window.SRStatus;
  var UI = window.SRUI;
  var B = window.SRBoard;
  var CFG = S.config;

  var current = null;     /* 后端当前那条记录 */
  var preview;            /* 预览看板实例 */
  var dirty = false;
  var unsubscribe = null; /* 订阅句柄：重复登录时必须先退订，否则会叠出多个 WebSocket */

  var el = {};

  function $(id) { return document.getElementById(id); }

  function cache() {
    ['loginView', 'editView', 'emailWrap', 'email', 'password', 'pwLabel', 'loginBtn', 'loginMsg',
     'providerName', 'quickBtns', 'eState', 'eAvail', 'eActivity', 'eMood', 'eMediaKind',
     'eMediaTitle', 'eMediaDetail', 'saveBtn', 'reloadBtn', 'signOutBtn', 'saveMsg',
     'dirtyFlag', 'whoAmI', 'whoAmI2', 'errBox', 'logCard', 'logList', 'metaUpdated', 'footProvider',
     'previewMount', 'previewLink', 'countActivity', 'countMood',
     'setupCard', 'setupState', 'setupProvider', 'setupMsg', 'setupSql', 'testBtn',
     'copySqlBtn', 'copyMsg'
    ].forEach(function (id) { el[id] = $(id); });
  }

  /* ------------------------------------------------------------- 表单读写 */

  function collect() {
    return {
      state: el.eState.value,
      availability: el.eAvail.value,
      activity: el.eActivity.value.trim(),
      mood: el.eMood.value.trim(),
      media: {
        kind: el.eMediaKind.value,
        title: el.eMediaTitle.value.trim(),
        detail: el.eMediaDetail.value.trim()
      }
    };
  }

  function fill(rec) {
    el.eState.value = rec.state;
    el.eAvail.value = rec.availability;
    el.eActivity.value = rec.activity || '';
    el.eMood.value = rec.mood || '';
    el.eMediaKind.value = (rec.media && rec.media.kind) || 'none';
    el.eMediaTitle.value = (rec.media && rec.media.title) || '';
    el.eMediaDetail.value = (rec.media && rec.media.detail) || '';
    updateCounters();
    markClean();
  }

  function updateCounters() {
    if (el.countActivity) el.countActivity.textContent = el.eActivity.value.length + '/80';
    if (el.countMood) el.countMood.textContent = el.eMood.value.length + '/160';
  }

  /* ------------------------------------------------------------- 预览 */

  function paintPreview() {
    if (!preview) return;
    var draft = collect();
    /* 时间沿用后端那句"上次更新"，因为这才是发布后别人看到的样子 */
    var saved = current || {};
    var rel = saved.updatedAt ? S.relativeTime(saved.updatedAt) : '刚刚';
    var abs = saved.updatedAt ? S.absoluteTime(saved.updatedAt) : '';
    var stale = false, mins = null;
    if (saved.updatedAt) {
      mins = (Date.now() - Date.parse(saved.updatedAt)) / 60000;
      stale = !isNaN(mins) && mins > (CFG.staleAfterMinutes || 180);
    }
    B.render(preview, draft, {
      relative: rel,
      absolute: abs,
      stale: stale,
      staleText: '这条状态已经放了一段时间了'
    });
    /* 预览里把"上次更新"换成一句提示，避免误导 */
    preview.ref.updatedRel.textContent = saved.updatedAt ? rel : '尚未发布';
    preview.ref.updatedAbs.textContent = dirty ? '（预览中，尚未保存）' : (abs || '');
  }

  function markDirty() {
    dirty = true;
    if (el.dirtyFlag) el.dirtyFlag.classList.add('show');
  }

  function markClean() {
    dirty = false;
    if (el.dirtyFlag) el.dirtyFlag.classList.remove('show');
  }

  function flash(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = 'msg ' + (kind || '');
  }

  /* ------------------------------------------------------------- 视图切换 */

  function refreshViews() {
    var can = S.canEdit();
    el.loginView.style.display = can ? 'none' : '';
    el.editView.style.display = can ? '' : 'none';
    if (can) {
      var who = S.email() ||
        (S.adapterName === 'jsonbin' ? 'Master Key 已保存' : '已登录');
      if (el.whoAmI) el.whoAmI.textContent = who;
      if (el.whoAmI2) el.whoAmI2.textContent = who;
    }
  }

  /* ------------------------------------------------------------- 后端自检 */

  /* 建表 SQL：邮箱从配置里取，所以策略不可能和 owner.email 对不上 */
  function sqlTemplate(email) {
    return [
      '-- 单行状态表',
      'create table if not exists public.status (',
      "  id           smallint primary key default 1,",
      "  state        text not null default 'offline'",
      "               check (state in ('alive','free','busy','sleep','offline')),",
      "  activity     text not null default '',",
      "  mood         text not null default '',",
      "  availability text not null default 'private'",
      "               check (availability in ('open','private','dnd')),",
      "  media        jsonb not null default '{\"kind\":\"none\",\"title\":\"\",\"detail\":\"\"}'::jsonb,",
      '  updated_at   timestamptz not null default now(),',
      '  constraint status_single_row check (id = 1)   -- 这张表永远只有一行',
      ');',
      '',
      'alter table public.status enable row level security;',
      '',
      '-- 策略一：任何人都能读（状态页是公开的）',
      'drop policy if exists "public can read status" on public.status;',
      'create policy "public can read status"',
      '  on public.status for select to anon, authenticated using (true);',
      '',
      '-- 策略二：只有这个邮箱能写  ← 这条就是"只有我能编辑"的全部依据',
      'drop policy if exists "owner can write status" on public.status;',
      'create policy "owner can write status"',
      '  on public.status for all to authenticated',
      "  using      (auth.jwt() ->> 'email' = '" + email + "')",
      "  with check (auth.jwt() ->> 'email' = '" + email + "');",
      '',
      '-- 自动维护 updated_at',
      'create or replace function public.touch_updated_at()',
      'returns trigger language plpgsql as $$',
      'begin',
      '  new.updated_at := now();',
      '  return new;',
      'end $$;',
      '',
      'drop trigger if exists trg_status_touch on public.status;',
      'create trigger trg_status_touch',
      '  before update on public.status',
      '  for each row execute function public.touch_updated_at();',
      '',
      '-- 先塞一行初始数据，这样你第一次保存就是 UPDATE 而不是 INSERT',
      'insert into public.status (id, state, activity, mood, availability, media)',
      "values (1, 'alive', '刚刚上线', '状态页终于能用了', 'open',",
      "        '{\"kind\":\"none\",\"title\":\"\",\"detail\":\"\"}'::jsonb)",
      'on conflict (id) do nothing;'
    ].join('\n');
  }

  /* 后端没配全时，把说明卡亮出来，并当场做一次连通性自检 */
  function setupSync() {
    if (!el.setupCard) return;
    el.setupProvider.textContent = CFG.provider;

    var ready = S.backendReady ? S.backendReady() : false;
    if (ready) {
      el.setupCard.style.display = 'none';
      return;
    }

    el.setupCard.style.display = '';
    var email = (CFG.owner && CFG.owner.email) || '你的邮箱';
    el.setupSql.textContent = sqlTemplate(email);
    flash(el.setupState, '未配置', 'err');

    if (CFG.provider === 'supabase' && S.testBackend) {
      S.testBackend().then(function (r) {
        flash(el.setupState, r.ok ? '连通' : '连接失败', r.ok ? 'ok' : 'err');
        flash(el.setupMsg, r.message, r.ok ? 'ok' : 'err');
      }).catch(function (e) {
        flash(el.setupState, '连接失败', 'err');
        flash(el.setupMsg, '自检请求失败：' + e.message, 'err');
      });
    } else {
      flash(el.setupState, CFG.provider === 'local' ? 'local 模式' : '未配置',
        CFG.provider === 'local' ? 'warn' : 'err');
      flash(el.setupMsg,
        CFG.provider === 'local'
          ? '当前 provider 是 local，状态取自 status.config.js 的 fallback，页面无法写入云端。'
          : '先把 status.config.js 里的 url / anonKey 填上，再刷新本页。',
        'warn');
    }
  }

  function boot() {
    cache();

    /* 预览看板 */
    if (el.previewMount) {
      preview = B.mount(el.previewMount, { compact: true });
    }

    el.footProvider.textContent = S.adapterName;
    el.providerName.textContent =
      S.adapterName === 'supabase' ? 'SUPABASE AUTH' :
      (S.adapterName === 'jsonbin' ? 'JSONBIN KEY' : 'LOCAL MODE');

    /* 下拉框从 board.js 的元数据生成，和公开页用的是同一份定义 */
    Object.keys(B.STATES).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = B.STATES[k].zh + '（' + B.STATES[k].en + '）';
      el.eState.appendChild(o);
    });
    Object.keys(B.AVAIL).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = B.AVAIL[k].zh;
      el.eAvail.appendChild(o);
    });

    /* 快捷状态 */
    B.QUICK.forEach(function (q) {
      var meta = B.STATES[q.state];
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = q.label;
      b.style.borderColor = meta.color + '66';
      b.style.color = meta.color;
      b.dataset.state = q.state;
      b.addEventListener('click', function () {
        el.eState.value = q.state;
        el.eAvail.value = q.avail;
        el.eActivity.value = q.activity;
        el.eMood.value = q.mood;
        el.eMediaKind.value = 'none';
        el.eMediaTitle.value = '';
        el.eMediaDetail.value = '';
        updateCounters();
        markDirty();
        paintPreview();
        flash(el.saveMsg, '已套用「' + q.label + '」，确认后点保存并同步', 'warn');
      });
      el.quickBtns.appendChild(b);
    });

    /* provider 差异化的登录表单 */
    if (S.adapterName === 'jsonbin') {
      el.emailWrap.style.display = 'none';
      el.pwLabel.textContent = 'JSONBin Master Key';
      el.password.setAttribute('placeholder', '$2a$10$...');
      el.password.setAttribute('autocomplete', 'off');
    } else if (S.adapterName === 'supabase') {
      /* 预先填上配置里的邮箱，少打一次字 */
      if (CFG.owner && CFG.owner.email) el.email.value = CFG.owner.email;
    } else {
      el.loginBtn.textContent = 'local 模式：去看怎么开同步';
      el.password.setAttribute('placeholder', 'local 模式不需要密码');
      el.password.disabled = true;
    }

    refreshViews();
    renderLog();
    load();
    setupSync();

    /* 表单改动 → 实时预览 */
    ['eState', 'eAvail', 'eActivity', 'eMood', 'eMediaKind', 'eMediaTitle', 'eMediaDetail']
      .forEach(function (id) {
        el[id].addEventListener('input', function () {
          updateCounters();
          markDirty();
          paintPreview();
        });
        el[id].addEventListener('change', function () {
          updateCounters();
          markDirty();
          paintPreview();
        });
      });

    /* 离开页面前提醒未保存 */
    window.addEventListener('beforeunload', function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    if (el.previewLink) {
      el.previewLink.href = el.previewLink.getAttribute('data-href') || 'status.html';
    }
  }

  function load() {
    return S.read().then(function (rec) {
      current = rec;
      fill(rec);
      paintPreview();
      if (el.metaUpdated) {
        el.metaUpdated.textContent = rec.updatedAt
          ? S.relativeTime(rec.updatedAt) + '（' + S.absoluteTime(rec.updatedAt) + '）'
          : '未知';
      }
      UI.renderIssues(el.errBox, UI.configIssues());
      if (S.adapterName !== 'local') {
        if (unsubscribe) unsubscribe();     /* 先退掉上一次，避免重复订阅 */
        unsubscribe = S.subscribe(function (fresh) {
          if (fresh && fresh._mode) { UI.setSync(fresh._mode); return; }
          /* 云端变了：只在本地没有未保存改动时才覆盖表单，避免吞掉你的输入 */
          current = fresh;
          if (!dirty) { fill(fresh); paintPreview(); }
          if (el.metaUpdated) {
            el.metaUpdated.textContent = fresh.updatedAt
              ? S.relativeTime(fresh.updatedAt) + '（' + S.absoluteTime(fresh.updatedAt) + '）'
              : '未知';
          }
        });
      } else {
        UI.setSync('local');
      }
    }).catch(function (e) {
      UI.setSync(S.adapterName === 'local' ? 'local' : 'poll');
      current = S.normalize(CFG.fallback || {});
      fill(current);
      paintPreview();
      UI.renderIssues(el.errBox, UI.configIssues(),
        '读取云端状态失败：' + e.message + '。表单里显示的是配置文件的兜底值。');
    });
  }

  /* ------------------------------------------------------------- 历史记录 */

  function renderLog() {
    var logs = (CFG.log || []).slice().sort(function (a, b) {
      return Date.parse(b.at) - Date.parse(a.at);
    }).slice(0, 10);

    if (!el.logCard) return;
    if (!logs.length) { el.logCard.style.display = 'none'; return; }
    el.logCard.style.display = '';
    el.logList.innerHTML = '';
    logs.forEach(function (item) {
      var meta = B.STATES[item.state] || B.STATES.offline;
      var li = document.createElement('li');
      var time = document.createElement('time');
      time.textContent = S.relativeTime(item.at);
      time.title = S.absoluteTime(item.at);
      var dot = document.createElement('span');
      dot.className = 'dot-s';
      dot.style.background = meta.color;
      dot.style.boxShadow = '0 0 10px ' + meta.color;
      var txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = item.text || meta.zh;
      li.appendChild(time); li.appendChild(dot); li.appendChild(txt);
      el.logList.appendChild(li);
    });
  }

  /* ------------------------------------------------------------- 事件 */

  function bind() {
    el.loginBtn.addEventListener('click', function () {
      if (S.adapterName === 'local') {
        flash(el.loginMsg, '当前是 local 模式：可以直接改 assets/js/status.config.js 的 fallback 区块，'
          + '或把 provider 改成 supabase / jsonbin 来开启实时同步', 'warn');
        return;
      }
      var email = el.email.value.trim();
      var secret = el.password.value;
      if (S.adapterName === 'supabase' && !email) { flash(el.loginMsg, '请填邮箱', 'err'); return; }
      if (!secret) { flash(el.loginMsg, '请填密码 / Key', 'err'); return; }

      el.loginBtn.disabled = true;
      flash(el.loginMsg, '登录中…', 'busy');

      S.signIn(email, secret).then(function () {
        el.password.value = '';
        flash(el.loginMsg, '✓ 登录成功', 'ok');
        refreshViews();
        return load();
      }).catch(function (e) {
        flash(el.loginMsg, '✗ ' + e.message, 'err');
      }).then(function () {
        el.loginBtn.disabled = false;
      });
    });

    el.loginView.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el.loginBtn.click();
    });

    el.saveBtn.addEventListener('click', function () {
      var patch = collect();
      if (patch.media.kind !== 'none' && !patch.media.title) {
        flash(el.saveMsg, '✗ 选了「最近在玩/在听」就得填个名称', 'err');
        return;
      }
      el.saveBtn.disabled = true;
      flash(el.saveMsg, '同步中…', 'busy');

      S.save(patch).then(function (fresh) {
        current = fresh;
        markClean();
        paintPreview();
        if (el.metaUpdated) {
          el.metaUpdated.textContent = S.relativeTime(fresh.updatedAt) +
            '（' + S.absoluteTime(fresh.updatedAt) + '）';
        }
        flash(el.saveMsg, '✓ 已同步 · ' + new Date().toLocaleTimeString('zh-CN'), 'ok');
      }).catch(function (e) {
        flash(el.saveMsg, '✗ ' + e.message, 'err');
      }).then(function () {
        el.saveBtn.disabled = false;
      });
    });

    el.reloadBtn.addEventListener('click', function () {
      if (dirty && !window.confirm('表单里有还没保存的改动，重新读取会丢掉它们。继续？')) return;
      flash(el.saveMsg, '读取中…', 'busy');
      load().then(function () {
        flash(el.saveMsg, '✓ 已重新读取', 'ok');
      });
    });

    el.signOutBtn.addEventListener('click', function () {
      if (dirty && !window.confirm('还有没保存的改动，退出登录会丢掉它们。继续？')) return;
      S.signOut().then(function () {
        markClean();
        refreshViews();
        flash(el.loginMsg, '已退出登录', 'ok');
        flash(el.saveMsg, '', '');
      });
    });

    /* ---- 后端自检按钮 ---- */
    if (el.testBtn) {
      el.testBtn.addEventListener('click', function () {
        if (!S.testBackend) return;
        el.testBtn.disabled = true;
        flash(el.setupMsg, '正在请求 Supabase…', 'busy');
        S.testBackend().then(function (r) {
          flash(el.setupState, r.ok ? '连通' : '连接失败', r.ok ? 'ok' : 'err');
          flash(el.setupMsg, r.message, r.ok ? 'ok' : 'err');
        }).catch(function (e) {
          flash(el.setupMsg, '请求失败：' + e.message, 'err');
        }).then(function () {
          el.testBtn.disabled = false;
        });
      });
    }

    if (el.copySqlBtn) {
      el.copySqlBtn.addEventListener('click', function () {
        var text = el.setupSql.textContent;
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
          flash(el.copyMsg, '✓ 已复制', 'ok');
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            flash(el.copyMsg, '✓ 已复制', 'ok');
          }).catch(fallback);
        } else {
          fallback();
        }
        setTimeout(function () { flash(el.copyMsg, '', ''); }, 2400);
      });
    });

    /* Ctrl / Cmd + Enter 直接保存 */
    el.editView.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') el.saveBtn.click();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); bind(); });
  } else {
    boot(); bind();
  }
})();
