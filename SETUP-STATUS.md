# 状态页接入指南 · status.html

这个页面要的是**真·实时双向同步**：你在手机上改状态 → 别人开着的页面自动变。
GitHub Pages 是纯静态站，自己做不到这件事，所以必须接一个后端。

已经帮你写好两个适配器，**选一个就行**：

| | Supabase（推荐） | JSONBin（简单） |
|---|---|---|
| 别人能不能改你的状态 | **不能**，数据库 RLS 核对邮箱 | 能，只要扒到你页面里的 Master Key |
| 实时推送 | ✅ WebSocket 订阅，秒级 | ❌ 靠轮询，约 20 秒 |
| 需要注册 | 要（免费） | 要（免费） |
| 前端要填的东西 | url + anon key（公开无妨） | binId + Access Key + Master Key |
| 跨设备 | ✅ 手机电脑同步 | ✅ |

**默认状态**：`assets/js/status.config.js` 里 `provider: 'local'` —— 页面立刻能看，状态写死在配置文件的 `fallback` 区块里，关标签页不会丢，但也不会同步。

---

## 方案 A · Supabase（推荐，5 分钟）

> **正确顺序**（顺序错了会踩坑）：
> 建项目 → 跑 SQL（建表 + 权限）→ **建你自己的账号**（邮箱必须和 SQL 里写的一致）→ 抄 URL 和 anon key → 填进配置 → 验证。
>
> 最容易搞错的就是中间那两步的顺序和邮箱一致性。

### 1. 建项目
1. 打开 https://supabase.com → 注册 / 登录 → **New project**
2. 名字随便（比如 `shenren-status`），**Database Password** 随便设一个强密码并**记下来**（这是数据库密码，不是网页登录密码，平时用不到，但丢了麻烦）
3. 区域选 **Northeast Asia (Tokyo)** 或 Singapore，延迟低
4. 等 1~2 分钟，等控制台从 "Setting up project" 变成正常界面再往下走

### 2. 建表 + 权限（关键，别跳过）

左侧 **SQL Editor** → **New query** → 把下面整段粘进去 → **Run**。

> 这段 SQL 已经填好了你自己的邮箱 `3355673688@qq.com`，**直接整段粘过去 Run 就行**，不用改任何东西。
>
> 需要注意的一点：QQ 邮箱在部分网络下收 Supabase 的验证邮件可能会延迟或被丢进垃圾箱 —— 所以步骤 3 建账号时**务必勾上 Auto Confirm User**，直接从源头绕开邮件验证。

```sql
-- 单行状态表
create table if not exists public.status (
  id           smallint primary key default 1,
  state        text not null default 'offline'
               check (state in ('alive','free','busy','sleep','offline')),
  activity     text not null default '',
  mood         text not null default '',
  availability text not null default 'private'
               check (availability in ('open','private','dnd')),
  media        jsonb not null default '{"kind":"none","title":"","detail":""}'::jsonb,
  updated_at   timestamptz not null default now(),
  constraint status_single_row check (id = 1)   -- 这张表永远只有一行
);

-- 开启行级安全
alter table public.status enable row level security;

-- 策略一：任何人都能读（状态页给所有人看）
drop policy if exists "public can read status" on public.status;
create policy "public can read status"
  on public.status for select
  to anon, authenticated
  using (true);

-- 策略二：只有这个邮箱能写（← 改这里的邮箱！）
drop policy if exists "owner can write status" on public.status;
create policy "owner can write status"
  on public.status for all
  to authenticated
  using      (auth.jwt() ->> 'email' = '3355673688@qq.com')
  with check (auth.jwt() ->> 'email' = '3355673688@qq.com');

-- 自动维护 updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_status_touch on public.status;
create trigger trg_status_touch
  before update on public.status
  for each row execute function public.touch_updated_at();

-- 先塞一行初始数据，这样你第一次保存就是 UPDATE 而不是 INSERT
insert into public.status (id, state, activity, mood, availability, media)
values (1, 'alive', '刚刚上线', '状态页终于能用了', 'open',
        '{"kind":"none","title":"","detail":""}'::jsonb)
on conflict (id) do nothing;
```

### 3. 建你自己的登录账号
左侧 **Authentication** → **Users** → **Add user** → **Create new user**
- 邮箱填 **`3355673688@qq.com`**（必须和步骤 2 的 SQL 里那个**一模一样**，否则 RLS 会拒绝你写入）
- 密码自己设一个，**记住它** —— 这就是你在状态页登录用的密码
- ☑️ **务必勾上 Auto Confirm User**

> 为什么特别强调勾选：QQ 邮箱在部分网络环境下收 Supabase 的验证邮件会延迟、甚至被丢进垃圾箱。
> 勾了 Auto Confirm 就完全绕开邮件验证，不会卡在这一步。
>
> 在 Supabase 控制台建用户是安全的。**千万不要**把"允许任何人注册"打开后把注册按钮放到页面上。

### 4. 拿到 url 和 anon key
左侧 **Project Settings**（齿轮图标）→ **API**：

- **Project URL** → 形如 `https://abcdefgh.supabase.co`（**结尾不要带 `/`**）
- 复制 **anon public** 那个 key。它是一长串 `eyJ...` 开头的 JWT

> ⚠️ 新版控制台改过名字，同一个东西可能叫：
> - `anon` / **`anon public`** ← 老版
> - **`Publishable key`** ← 新版
>
> 这些都是**可以公开**的，放前端没问题。
>
> ❌ **绝对不要**复制 `service_role` / `Secret key` —— 那个能绕过所有 RLS 策略，
> 一旦放进前端等于把数据库钥匙挂在门上。如果你不小心提交过，去 `API` 页面 **Reset/Rotate** 一下。

> 你的写权限不是靠这个 key，而是靠登录后拿到的 JWT + 步骤 2 里的 RLS 策略。

### 5. 填进配置
打开 `assets/js/status.config.js`，改这三处：

```js
provider: 'supabase',
supabase: {
  url: 'https://abcdefgh.supabase.co',
  anonKey: '粘贴 anon public key',
  table: 'status'
},
```

### 6. 验证

**先在浏览器地址栏里空手验一次**（不用跑页面，最快确认 key 和表是否就绪）。
把你自己的 URL 和 key 代进去，直接访问：

```
https://你的项目.supabase.co/rest/v1/status?select=*&apikey=你的publishable_key
```

| 返回内容 | 含义 |
|---|---|
| `[]` | ✅ 项目、key、表**全都正常**，只是表里还没数据 —— 可以往下走了 |
| `[{"id":1,"state":"alive",...}]` | ✅ 已经跑过 SQL 而且有初始数据了 |
| `{"code":"42P01","message":"relation \"public.status\" does not exist"}` | ⛔ 建表 SQL 还没跑，回步骤 2 |
| `{"message":"Invalid API key"}` | ⛔ key 抄错了，或者已经被 Rotate 过 |
| `{"code":"42501",...}` | ⛔ 表建了但 SELECT 策略没建，回步骤 2 补策略那段 |

然后跑整页验证：

1. push 上去，打开 `你的域名/status.html`
2. 右上角徽标应该从"轮询同步中"变成 **实时同步中**（详见下方排查表）
3. 点 **「我是本人 · 编辑状态」** → 用步骤 3 的邮箱密码登录
4. 改个状态 → **保存并同步**
5. **换一台设备 / 一个浏览器**打开同一页面 —— 不刷新也应该自己变

### 7. 出问题时，先跑这两条诊断

在 Supabase 的 **SQL Editor** 里跑：

```sql
-- ① 表和策略都建好了吗？应该能看到 1 行数据 + 2 条策略
select * from public.status;
select policyname, cmd, roles from pg_policies where tablename = 'status';
```

在**状态页**上按 F12 打开控制台，登录后跑：

```js
// ② 我到底是以谁的身份在写？把 email 和 SQL 里那个对一下
JSON.parse(localStorage.getItem('sr_status_session_v1')).email
```

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 保存报 `HTTP 403` / `new row violates row-level security` | 登录邮箱 ≠ RLS 策略里的邮箱 | 策略里现在写的是 `3355673688@qq.com`。去 `Authentication → Users` 核对账号邮箱是否一致；不一致就改用户邮箱，或改 SQL 里那 2 处 `using` / `with check` 后重跑策略段 |
| 登录报 `Invalid login credentials` | 用户在 `Authentication → Users` 里没建，或没勾 Auto Confirm | 重新建用户并**勾上 Auto Confirm User** |
| 登录报 `Email not confirmed` | 建用户时漏勾 Auto Confirm | 在 Users 列表里点那个用户 → 手动 Confirm |
| 徽标显示"轮询同步中"不变成"实时同步中" | ① Realtime publication 没包含 status 表；② 新版 `sb_publishable_` key 有时不被 Realtime 的 WebSocket 接受（它要 JWT） | 先跑 `alter publication supabase_realtime add table public.status;`。还是不行就是 ②：不影响使用，页面会自动降级成 20 秒轮询；想强制走实时，把 `API` 页面里 **legacy anon JWT**（`eyJ...` 开头那个）填进 `anonKey` |
| 保存成功但别的设备不变 | 别的设备页面停在后台标签页了 | 切回前台它会立即重读；或者点编辑面板里的「重新读取」 |
| 跑 SQL 报 `relation "public.status" already exists` | 之前跑过一次 | 无害，`create table if not exists` 已忽略；策略和触发器那段也有 `drop ... if exists`，整段重跑即可 |
| 页面一直显示配置文件里的兜底状态 | `url` / `anonKey` 没填对，或结尾多了 `/` | 打开 F12 看 Network 里对 `.../rest/v1/status` 的请求返回了什么 |

---

## 方案 B · JSONBin（更简单，但安全性低）

### 1. 建 bin
1. 打开 https://jsonbin.io → 注册 → **Bins** → **Create Bin**
2. 内容粘这段：

```json
{
  "state": "alive",
  "activity": "刚刚上线",
  "mood": "状态页终于能用了",
  "availability": "open",
  "media": { "kind": "none", "title": "", "detail": "" },
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

3. 创建后从地址栏拿到 **Bin ID**（形如 `65f0c...`）
4. 右上角 **API Keys** 里拿 **X-MASTER-KEY** 和 **X-ACCESS-KEY**

### 2. 填进配置

```js
provider: 'jsonbin',
jsonbin: {
  binId: '你的 bin id',
  readKey: 'X-Access-Key',
  writeKey: ''          // 不用填在这里
},
```

### 3. 使用
点 **「我是本人 · 编辑状态」** → 在密码框里填 **Master Key** → 登录。
Master Key 只会存在**你自己这台设备**的 localStorage 里，不会提交到仓库。

### ⚠️ 这个方案的安全边界
- 页面源码里的 `readKey` 是公开的，本来也只读，无所谓
- 但**写权限完全依赖 Master Key**。如果哪天你在别人电脑上登录过、或者 Key 泄漏了，别人就能改你的状态
- 所以：**只在可信设备上填 Master Key**，别在网吧/公用电脑上开

---

## 状态字段一览

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | `alive` / `free` / `busy` / `sleep` / `offline` | 主状态大字，决定整页强调色 |
| `activity` | 文本（≤80） | 当前在做什么 |
| `mood` | 文本（≤160） | 心情 / 一句话吐槽 |
| `availability` | `open` / `private` / `dnd` | 档期，映射成 5 格可打扰条 |
| `media.kind` | `none` / `game` / `music` / `video` | 最近在玩 / 在听 |
| `media.title` | 文本（≤70） | 名称 |
| `media.detail` | 文本（≤90） | 补充一句 |
| `updated_at` | 数据库自动维护 | 页面上显示成"上次更新 X 分钟前" |

**过期提示**：超过 `status.config.js` 里的 `staleAfterMinutes`（默认 180 分钟）没更新，
页面会在状态旁边亮一个黄色「这条状态已经放了一段时间了」的提示，避免别人被过期状态误导。

---

## 想脱离后端，只想手改文件？

把 `provider` 保持 `'local'`，然后改配置里的 `fallback` 区块：

```js
fallback: {
  state: 'busy',
  activity: '在写期末作业，勿扰',
  mood: '别催',
  availability: 'dnd',
  media: { kind: 'music', title: '正在循环的歌', detail: '' },
  updatedAt: '2026-01-01T20:30:00+08:00'
}
```

改完 push，状态页立刻变。**只有能 push 到仓库的你本人能改** —— 某种意义上这才是最严格的"只有我能编辑"。

---

## 常见问题

**登录成功但保存报 403 / RLS 错误**
→ 99% 是 `create policy "owner can write status"` 里的邮箱和登录邮箱不一致。
去 SQL Editor 跑 `select auth.jwt() ->> 'email'` 不方便，直接核对 `Authentication → Users` 里的邮箱，重新跑一遍策略那段 SQL。

**页面显示"轮询同步中"而不是"实时同步中"**
→ Realtime 没连上。检查：`Database → Replication` 里 `supabase_realtime` publication 是否包含 `status` 表；
或者把 `provider` 临时切到 jsonbin 看是不是网络问题。轮询模式功能上也能用，只是慢 20 秒。

**改了配置但页面没变**
→ 浏览器缓存。硬刷新（Ctrl/Cmd + Shift + R）。`status.config.js` 是普通 script，没有哈希指纹。

**想在状态变更时留一条历史记录**
→ 在 `status.config.js` 的 `log` 数组里手动加：

```js
log: [
  { at: '2026-01-01T20:30:00+08:00', state: 'alive', text: '上线了' },
  { at: '2026-01-01T03:00:00+08:00', state: 'sleep', text: '睡了，勿扰' }
]
```

留空数组就整块隐藏。想全自动记录的话需要再加一张表 + 触发器，说一声我给你加。
