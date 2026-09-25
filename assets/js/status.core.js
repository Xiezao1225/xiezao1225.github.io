/* ============================================================================
 * 神人工业 · 状态页核心
 * ----------------------------------------------------------------------------
 * 零依赖。只用 fetch + WebSocket。
 *   - LocalAdapter    : 读配置里的 fallback，不可写
 *   - SupabaseAdapter : REST 读写 + 邮箱密码登录 + Realtime 推送
 *   - JsonBinAdapter  : REST 读写 + 轮询
 *
 * 对外暴露一个极小的 API：
 *   SRStatus.read()                      -> Promise<record>
 *   SRStatus.canEdit()                   -> boolean
 *   SRStatus.signIn(email, password)     -> Promise<void>
 *   SRStatus.signOut()                   -> Promise<void>
 *   SRStatus.save(patch)                 -> Promise<record>
 *   SRStatus.onChange(fn)                -> unsubscribe
 * ==========================================================================*/
(function () {
  'use strict';

  var CFG = window.SR_STATUS_CONFIG || {};
  var SUPA = CFG.supabase || {};
  var JB = CFG.jsonbin || {};

  /* ------------------------------------------------------------------ 工具 */

  var STATES = ['alive', 'free', 'busy', 'sleep', 'offline'];
  var AVAIL = ['open', 'private', 'dnd'];

  function nowIso() { return new Date().toISOString(); }

  function normalize(raw) {
    raw = raw || {};
    var media = raw.media || {};
    return {
      state: STATES.indexOf(raw.state) >= 0 ? raw.state : 'offline',
      activity: String(raw.activity || ''),
      mood: String(raw.mood || ''),
      availability: AVAIL.indexOf(raw.availability) >= 0 ? raw.availability : 'private',
      media: {
        kind: ['game', 'music', 'video', 'none'].indexOf(media.kind) >= 0 ? media.kind : 'none',
        title: String(media.title || ''),
        detail: String(media.detail || '')
      },
      updatedAt: raw.updatedAt || raw.updated_at || '',
      _local: !!raw._local
    };
  }

  /* 统一成"人话"的时间差 */
  function relativeTime(iso, tz) {
    if (!iso) return '未知';
    var t = Date.parse(iso);
    if (isNaN(t)) return '未知';
    var diff = Date.now() - t;
    var future = diff < -30000;
    var s = Math.abs(Math.round(diff / 1000));
    var text;
    if (s < 45) text = '刚刚';
    else if (s < 3600) text = Math.round(s / 60) + ' 分钟前';
    else if (s < 86400) text = Math.round(s / 3600) + ' 小时前';
    else if (s < 86400 * 30) text = Math.round(s / 86400) + ' 天前';
    else text = new Date(t).toLocaleDateString('zh-CN');
    return future ? text.replace('前', '后') : text;
  }

  function absoluteTime(iso, tz) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    try {
      return new Date(t).toLocaleString('zh-CN', {
        timeZone: tz || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return new Date(t).toLocaleString('zh-CN');
    }
  }

  async function jsonOrThrow(res, what) {
    var text = await res.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      var msg = (body && (body.message || body.error_description || body.error || body.msg)) || res.status;
      throw new Error(what + ' 失败（HTTP ' + res.status + '）：' + msg);
    }
    return body;
  }

  /* 极简发布订阅 */
  var listeners = [];
  function emit(rec) {
    listeners.forEach(function (fn) {
      try { fn(rec); } catch (e) { console.error(e); }
    });
  }

  /* ---------------------------------------------------------------- 本地态 */

  function localRecord() {
    var f = CFG.fallback || {};
    f._local = true;
    return normalize(f);
  }

  /* ================================================================ Supabase */

  function supabaseBase() {
    var u = String(SUPA.url || '').trim();
    /* 容忍误填：把 /rest/v1、/auth/v1 这类路径后缀和结尾斜杠都剥掉。
       很多人（包括我们自己）会直接从控制台复制到带 /rest/v1 的 REST endpoint。 */
    u = u.replace(/\/+$/, '');
    var cut = u.search(/\/(rest|auth|realtime|storage)\/v\d+$/i);
    if (cut > 0) u = u.slice(0, cut);
    return u;
  }
  function supabaseReady() {
    return CFG.provider === 'supabase' && !!supabaseBase() && !!SUPA.anonKey;
  }

  var SESSION_KEY = 'sr_status_session_v1';

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  function SupabaseAdapter() {
    var base = supabaseBase();
    var table = SUPA.table || 'status';
    var session = loadSession();
    var refreshTimer = null;
    var ws = null, wsRef = 0, heartbeat = null, retry = 0, stopped = true;
    var pollTimer = null, realtimeOk = false, onRemote = null;

    function authed() { return !!(session && session.access_token); }

    async function doRefresh() {
      if (!session || !session.refresh_token) throw new Error('没有可刷新的会话');
      var res = await fetch(base + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'apikey': SUPA.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      var data = await jsonOrThrow(res, '刷新登录');
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
        email: (data.user && data.user.email) || session.email
      };
      saveSession(session);
      scheduleRefresh();
      return session;
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      if (!session || !session.expires_at) return;
      var ms = Math.max(5000, session.expires_at - Date.now());
      refreshTimer = setTimeout(function () {
        doRefresh().catch(function (e) {
          console.warn('[SRStatus] 自动续期失败：', e.message);
          signOut();
        });
      }, ms);
    }

    async function ensureFresh() {
      if (!session) throw new Error('未登录');
      if (session.expires_at && Date.now() > session.expires_at - 10000) {
        await doRefresh();
      } else if (!session.expires_at) {
        await doRefresh();
      }
      return session;
    }

    /* --- REST --- */

    function readHeaders() {
      var h = { 'apikey': SUPA.anonKey, 'Accept': 'application/json' };
      if (authed()) h['Authorization'] = 'Bearer ' + session.access_token;
      return h;
    }

    async function read() {
      var url = base + '/rest/v1/' + encodeURIComponent(table) + '?select=*&id=eq.1';
      var res = await fetch(url, { headers: readHeaders(), cache: 'no-store' });
      var rows = await jsonOrThrow(res, '读取状态');
      if (!rows || !rows.length) return normalize({ state: 'offline', updatedAt: '' });
      return normalize(rows[0]);
    }

    async function save(patch) {
      await ensureFresh();
      var row = Object.assign({
        state: 'alive', activity: '', mood: '',
        availability: 'private', media: { kind: 'none', title: '', detail: '' }
      }, patch);
      var res = await fetch(base + '/rest/v1/' + encodeURIComponent(table) + '?id=eq.1&select=*', {
        method: 'PATCH',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        }, readHeaders()),
        body: JSON.stringify(row)
      });

      if (res.status === 401 || res.status === 403) {
        var text = await res.text();
        throw new Error('服务器拒绝写入（HTTP ' + res.status + '）。'
          + '多半是 RLS 策略没建，或这个账号不是 status.html 里配置的所有者邮箱。原始信息：' + text);
      }
      var rows = await jsonOrThrow(res, '保存状态');

      /* PATCH 没命中任何行时，退化成 INSERT（第一次使用、表里还没有 id=1 这行） */
      if (!rows || !rows.length) {
        var ins = await fetch(base + '/rest/v1/' + encodeURIComponent(table) + '?select=*', {
          method: 'POST',
          headers: Object.assign({
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          }, readHeaders()),
          body: JSON.stringify(Object.assign({ id: 1 }, row))
        });
        rows = await jsonOrThrow(ins, '创建状态行');
      }
      return normalize(rows && rows[0]);
    }

    async function signIn(email, password) {
      var res = await fetch(base + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'apikey': SUPA.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      var data = await jsonOrThrow(res, '登录');
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
        email: (data.user && data.user.email) || email
      };
      saveSession(session);
      scheduleRefresh();
      startRealtime();
    }

    async function signOut() {
      var tok = session && session.access_token;
      session = null;
      saveSession(null);
      clearTimeout(refreshTimer);
      stopRealtime();
      if (tok) {
        try {
          await fetch(base + '/auth/v1/logout', {
            method: 'POST',
            headers: { 'apikey': SUPA.anonKey, 'Authorization': 'Bearer ' + tok }
          });
        } catch (e) { /* 离线登出也当成功 */ }
      }
    }

    /* --- Realtime（Phoenix 协议）--- */

    function realtimeUrl() {
      return base.replace(/^http/, 'ws') + '/realtime/v1/websocket'
        + '?apikey=' + encodeURIComponent(SUPA.anonKey) + '&vsn=1.0.0';
    }

    function startRealtime() {
      if (stopped || typeof WebSocket === 'undefined') return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      try { ws = new WebSocket(realtimeUrl()); } catch (e) { return; }

      ws.onopen = function () {
        retry = 0;
        wsRef++;
        var ref = String(wsRef);
        ws.send(JSON.stringify({
          topic: 'realtime:' + wsRef, event: 'phx_join', ref: ref,
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: '' },
              postgres_changes: [{
                event: '*', schema: 'public', table: table, filter: 'id=eq.1'
              }]
            },
            access_token: (session && session.access_token) || SUPA.anonKey
          }
        }));
        heartbeat = setInterval(function () {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++wsRef) }));
          }
        }, 25000);
      };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.event) return;

        if (msg.event === 'postgres_changes') {
          var rec = msg.payload && msg.payload.data && msg.payload.data.record;
          if (rec) emit(normalize(rec));
          else read().then(emit).catch(function () {});
        }

        if (msg.event === 'phx_reply') {
          if (msg.payload && msg.payload.status === 'ok') {
            /* 订阅成功 → 关掉降级轮询，回到实时模式 */
            realtimeOk = true;
            stopPoll();
            notifyMode();
          } else if (msg.payload && msg.payload.status === 'error') {
            /* 常见于把新版 sb_publishable_ key 塞给 Realtime：它要的是 JWT。
               不报错打断用户，直接降级成轮询，页面照样能同步。 */
            realtimeOk = false;
            startPoll();
            notifyMode();
            console.warn('[SRStatus] Realtime 订阅被拒，已降级为轮询：', msg.payload.response);
          }
        }
      };

      ws.onclose = function () {
        clearInterval(heartbeat);
        if (stopped) return;
        realtimeOk = false;
        startPoll();
        notifyMode();
        retry = Math.min(retry + 1, 6);
        setTimeout(startRealtime, 1000 * Math.pow(2, retry - 1));
      };

      ws.onerror = function () { /* onclose 会跟上 */ };
    }

    /* 降级轮询：Realtime 连不上或没权限时，靠它保证数据仍然是新的 */
    function startPoll() {
      if (pollTimer || !onRemote) return;
      pollTimer = setInterval(function () {
        if (document.hidden || realtimeOk) return;
        read().then(function (r) { if (!realtimeOk) onRemote(r); }).catch(function () {});
      }, Math.max(10000, CFG.pollInterval || 20000));
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function notifyMode() {
      emit({ _mode: realtimeOk ? 'realtime' : 'poll' });
    }

    function stopRealtime() {
      stopped = true;
      realtimeOk = false;
      stopPoll();
      clearInterval(heartbeat);
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    }

    function subscribe(onChange) {
      onRemote = onChange;
      stopped = false;
      realtimeOk = false;
      startRealtime();
      startPoll();            /* 先开着轮询兜底；Realtime 一连上就自动关掉 */
      function onVis() {
        if (document.hidden) {
          stopRealtime();
        } else {
          stopped = false;
          read().then(onChange).catch(function () {});
          startRealtime();
          startPoll();
        }
      }
      document.addEventListener('visibilitychange', onVis);
      return function () {
        document.removeEventListener('visibilitychange', onVis);
        onRemote = null;
        stopRealtime();
      };
    }

    if (session) scheduleRefresh();

    return {
      name: 'supabase',
      supportsRealtime: true,
      read: read,
      save: save,
      canEdit: function () { return authed(); },
      email: function () { return session && session.email; },
      signIn: signIn,
      signOut: signOut,
      subscribe: subscribe,
      dispose: stopRealtime
    };
  }

  /* ================================================================= JsonBin */

  function jsonbinReady() {
    return CFG.provider === 'jsonbin' && !!JB.binId && !!JB.readKey;
  }

  function JsonBinAdapter() {
    var base = 'https://api.jsonbin.io/v3/b/' + JB.binId;
    var WRITE_KEY_STORE = 'sr_status_jsonbin_writekey';

    function getWriteKey() {
      try { return localStorage.getItem(WRITE_KEY_STORE) || ''; } catch (e) { return ''; }
    }
    function setWriteKey(k) {
      try { k ? localStorage.setItem(WRITE_KEY_STORE, k) : localStorage.removeItem(WRITE_KEY_STORE); }
      catch (e) {}
    }

    async function read() {
      var res = await fetch(base + '/latest', {
        headers: { 'X-Access-Key': JB.readKey, 'Accept': 'application/json' },
        cache: 'no-store'
      });
      var data = await jsonOrThrow(res, '读取状态');
      return normalize(data && data.record);
    }

    async function save(patch) {
      var key = getWriteKey();
      if (!key) throw new Error('还没填 JSONBin 的 Master Key，先在编辑面板里填一次。');
      /* JSONBin 的 PUT 是整份覆盖，所以先读后合并，避免丢字段 */
      var current = {};
      try { current = await read(); } catch (e) {}
      var row = Object.assign({}, current, patch, { updatedAt: nowIso() });
      delete row._local;

      var res = await fetch(base, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': key,
          'X-Bin-Versioning': 'false'
        },
        body: JSON.stringify(row)
      });
      var data = await jsonOrThrow(res, '保存状态');
      return normalize((data && data.record) || row);
    }

    function subscribe(onChange) {
      var timer = null;
      function tick() {
        if (!document.hidden) read().then(onChange).catch(function () {});
      }
      timer = setInterval(tick, Math.max(5000, CFG.pollInterval || 20000));
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) tick();
      });
      return function () { clearInterval(timer); };
    }

    return {
      name: 'jsonbin',
      supportsRealtime: false,
      read: read,
      save: save,
      canEdit: function () { return !!getWriteKey(); },
      email: function () { return null; },
      signIn: async function (email, key) {
        if (!key) throw new Error('请填写 JSONBin Master Key');
        setWriteKey(key);
        await read(); /* 顺便验证 key 对应的 bin 可读 */
      },
      signOut: async function () { setWriteKey(''); },
      subscribe: subscribe,
      setWriteKey: setWriteKey,
      dispose: function () {}
    };
  }

  /* ================================================================== Local */

  function LocalAdapter() {
    return {
      name: 'local',
      supportsRealtime: false,
      read: async function () { return localRecord(); },
      save: async function () {
        throw new Error('当前 provider 是 local，页面不能写入。'
          + '要么直接改 assets/js/status.config.js 里的 fallback，'
          + '要么把 provider 改成 supabase / jsonbin 来开启实时同步。');
      },
      canEdit: function () { return false; },
      email: function () { return null; },
      signIn: async function () { throw new Error('local 模式不需要登录'); },
      signOut: async function () {},
      subscribe: function () {},
      dispose: function () {}
    };
  }

  /* ========================================================= 配置自检
     把"填错了但页面上看不出为什么"的情况提前说清楚，
     尤其是 RLS 策略里的邮箱 —— 那个藏在数据库里，报错信息很难懂。 */

  var OWNER_EMAIL_RE = /auth\.jwt\(\)\s*->>\s*'email'\s*=\s*'([^']+)'/;

  function configIssues() {
    var issues = [];

    if (CFG.provider === 'supabase') {
      if (!SUPA.url || !SUPA.anonKey) {
        issues.push({
          level: 'error',
          text: 'Supabase 还没配全：assets/js/status.config.js 里的 url / anonKey 至少有一个是空的。'
        });
      } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(supabaseBase())) {
        issues.push({
          level: 'warn',
          text: 'url 看起来不太对（当前解析为 ' + supabaseBase() + '）。'
              + '正常形如 https://abcdefgh.supabase.co，只到主域名为止。'
        });
      }
      var ownerEmail = (CFG.owner && CFG.owner.email) || '';
      if (ownerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
        issues.push({ level: 'warn', text: 'owner.email 不像一个邮箱地址：' + ownerEmail });
      }
      if (!ownerEmail) {
        issues.push({
          level: 'warn',
          text: '还没在 status.config.js 的 owner.email 里填你的邮箱。'
              + '它必须和 Supabase 里那条 RLS 策略中的邮箱完全一致，否则保存会被拒绝。'
        });
      }
    }

    if (CFG.provider === 'jsonbin' && (!JB.binId || !JB.readKey)) {
      issues.push({ level: 'error', text: 'JSONBin 还没配全：binId 或 readKey 是空的。' });
    }

    if (CFG.provider === 'local') {
      issues.push({
        level: 'info',
        text: '当前是 local 模式：状态写死在 status.config.js 的 fallback 里，页面无法写入云端。'
      });
    }
    return issues;
  }

  /* 从用户粘进配置的 SQL 里，自动认出 RLS 策略中的邮箱 */
  function detectOwnerEmail(sql) {
    var m = OWNER_EMAIL_RE.exec(String(sql || ''));
    return m ? m[1] : null;
  }

  /* =============================================================== 工厂 */

  var adapter;
  if (supabaseReady()) adapter = SupabaseAdapter();
  else if (jsonbinReady()) adapter = JsonBinAdapter();
  else adapter = LocalAdapter();

  window.SRStatus = {
    config: CFG,
    states: STATES,
    availabilities: AVAIL,
    adapterName: adapter.name,
    relativeTime: relativeTime,
    absoluteTime: absoluteTime,
    normalize: normalize,
    read: function () { return adapter.read(); },
    save: function (p) { return adapter.save(p); },
    canEdit: function () { return adapter.canEdit(); },
    email: function () { return adapter.email(); },
    signIn: function (a, b) { return adapter.signIn(a, b); },
    signOut: function () { return adapter.signOut(); },
    configIssues: configIssues,
    detectOwnerEmail: detectOwnerEmail,
    baseUrl: supabaseBase,
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    _emit: emit,
    subscribe: function (fn) { return adapter.subscribe(fn); },
    hasBackend: adapter.name !== 'local',
    dispose: function () { adapter.dispose(); }
  };
})();
