/* ============================================================================
 * 神人工业 · 状态页配置  ——  只有你需要改这个文件
 * ----------------------------------------------------------------------------
 * 这个文件是"唯一真相来源"。改完存盘、commit、push，状态页立刻生效。
 *
 * provider 三选一：
 *   'local'    —— 不接后端。状态就写在本文件的 `fallback` 区块里，只有你自己能看到改动结果。
 *   'supabase' —— 推荐。任何人可读；只有你在 status.html 里用邮箱+密码登录后才能写。
 *                 支持 Realtime 推送：你手机改完，别人开着的页面自动变。
 *   'jsonbin'  —— 备选。用 JSONBin 的 Master Key 写入，靠轮询同步。
 *
 * 详细的注册 / 建表 / 拿 key 步骤见仓库根目录的 SETUP-STATUS.md
 * ==========================================================================*/

window.SR_STATUS_CONFIG = {

  provider: 'supabase',

  /* 你本人的标识（展示用） */
  owner: {
    name: 'xiezao',
    handle: '@xiezao1225',
    title: '神人工业 · 核心架构师',
    avatar: 'https://minotar.net/helm/xiezao/160.png',

    /* ⚠️ 邮箱必须和你在 Supabase 里那条 RLS 策略中的邮箱完全一致，
       否则保存时会被数据库拒绝（HTTP 403 / row-level security）。
       它只用来做配置自检和提示，前端不靠它鉴权 —— 真正的把关在数据库里。 */
    email: '3355673688@qq.com'
  },

  /* 状态多久没更新就显示成"可能已过期"。单位分钟。 */
  staleAfterMinutes: 180,

  /* 轮询间隔（毫秒）。只在没有 Realtime 推送时生效（jsonbin / 降级情况）。 */
  pollInterval: 20000,

  /* 对外只读埋点：暂时留空即可 */
  timezone: 'Asia/Shanghai',

  /* --------------------------------------------------------------------------
   * provider: 'supabase'
   *   url  —— 形如 https://abcdefgh.supabase.co   （注意不要带结尾的 /）
   *   anonKey —— Supabase 的 anon public key，公开也无所谓（受 RLS 保护，只能读）
   *   写权限不靠这个 key，而靠你在页面上登录得到的 JWT；数据库 RLS 会核对邮箱。
   * ------------------------------------------------------------------------*/
  supabase: {
    // ⚠️ 只填到主域名为止！不要带结尾的 / ，也不要带 /rest/v1
    //    ✅ https://mwllhesriszibxotmrln.supabase.co
    //    ❌ https://mwllhesriszibxotmrln.supabase.co/rest/v1
    //    （代码里已经做了自动纠偏，但填对最省事）
    url: 'https://mwllhesriszibxotmrln.supabase.co',
    anonKey: 'sb_publishable_SnUVwwX1QJsIbgk7YS5h8Q_uRA6O-gi',
    table: 'status'
  },

  /* --------------------------------------------------------------------------
   * provider: 'jsonbin'
   *   binId     —— 创建 bin 后地址栏里那串 id
   *   readKey   —— X-Access-Key，可读
   *   writeKey  —— X-Master-Key，能写！它会出现在页面里，安全性低于 Supabase。
   *                所以只在你不介意"别人扒到 key 就能改你状态"时使用。
   * ------------------------------------------------------------------------*/
  jsonbin: {
    binId: '',
    readKey: '',
    writeKey: ''
  },

  /* --------------------------------------------------------------------------
   * provider: 'local' 时展示的状态（同时作为后端读取失败时的兜底显示）
   * 想手动改状态就改这里。
   * ------------------------------------------------------------------------*/
  fallback: {
    state: 'alive',                 // alive | free | busy | sleep | offline
    activity: '正在重构神人工业的首页',
    mood: '今天不想动，但代码自己动起来了',
    availability: 'private',        // open | private | dnd
    media: {
      kind: 'game',                 // game | music | video | none
      title: 'Minecraft · mcjs.link',
      detail: '在刷石机旁边挂机'
    },
    /* 想显示"上次更新于"就把这里填成 ISO 时间，留空则显示"未知" */
    updatedAt: ''
  },

  /* 历史日志（可选）。留空数组就整块不显示。 */
  log: [
    // { at: '2026-01-01T12:00:00+08:00', state: 'alive', text: '上线了' },
    // { at: '2026-01-01T03:00:00+08:00', state: 'sleep', text: '睡了，勿扰' }
  ]
};
