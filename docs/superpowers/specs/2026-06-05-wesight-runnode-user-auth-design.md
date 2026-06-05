# WeSight × RunNode 用户体系接入 — Design

## Overview

把 WeSight 当前基于 URS（统一登录中心）的 OAuth 单点登录，替换为对接 RunNode 业务云的会员体系。完全参考 RClaw 已落地的接口契约（`/app-api/member/auth/*` + `/app-api/member/user/get` + `/app-api/claw/user/device/*`），但用 WeSight 原生的直 IPC 模式实现，token 用 SQLCipher 加密存进现有 SQLite 库，URS 残留代码做一次硬重置清理。

> 范围限制：**本 spec 只解决"用户体系"（登录、token 持久化、设备注册、401 兜底）。** RunNode 模型同步、套餐/算力币展示、engine 初始化配置、Claw Catalog 数字员工分别在 B / C / D 三个 spec 中处理。

## Problem

WeSight 当前的登录体系有几个核心问题，导致无法承接 RunNode 业务云：

1. **单点 OAuth 锁死 URS 协议** — 流程是 `system browser → wesight://auth/callback → /api/auth/exchange`，没有密码/短信/微信扫码等会员域常见入口；一旦切换业务云，整套都得重写。
2. **token 明文存 SQLite** — `auth_tokens` 表是明文，依赖 OS 文件权限，达不到会员 token 的安全水位。
3. **没有设备维度** — RunNode 业务云的 `claw/user/device` 通道要求每台设备有 id + 周期心跳，WeSight 完全缺。
4. **没有 RunNode API 反向代理 + 401 自动重试** — RClaw 在 `CloudAuthService.fetchMemberAuthorized()` 里做了，WeSight 没有对应层。
5. **登录是 optional** — 跟 RunNode 模型必登录的要求冲突。

RClaw 已经把这套做完了（`cloud-auth.ts` + `cloud-auth-token-store.ts` + `cloud-platform-provider.ts` + `docs/api-docs/04_Member_API.md` + `08_Claw_User_Device_API.md`），可以直接参照接口契约，但 RClaw 是 host-api HTTP server + electron-store 加密方案，WeSight 是直 IPC + SQLite，要做适配。

## Design

### Approach：直 IPC 重写（贴合 WeSight 风格）

把 RClaw 的接口契约（请求/响应形状、401 兜底行为、token 滚动续期）翻译为 WeSight 原生的 `ipcMain.handle` 模式，渲染层走 `window.electron.cloudAuth.*`。**不引入 host-api HTTP server**，不复制 RClaw 的 `cloudFetchLogged` / `parseMemberAuthLoginBody` 等内部工具，自己撸适配版。

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         Renderer (React)                       │
│                                                                │
│  App.tsx ──► LoginGate ──► LoginModal / WechatQrDialog        │
│       │                │                                       │
│       ▼                ▼                                       │
│  cloudAuthService ─► window.electron.cloudAuth.{login,...}     │
│       │                                                        │
│       └─► cloudAuthSlice (Redux)  ◄──  IPC events              │
│              (isLoggedIn, user, hasCompletedFirstLogin)        │
└────────────────────────────┬───────────────────────────────────┘
                             │ ipcRenderer.invoke
┌────────────────────────────▼───────────────────────────────────┐
│                       Electron Main                            │
│                                                                │
│  ipcMain.handle('cloud:auth:*')  ──►  CloudAuthService        │
│                              │                                │
│                              │  (cloudUserDeviceService 在 main │
│                              │   内部 self-schedule，外部不调)  │
│                              ▼                                │
│                       CloudAuthTokenStore (SQLCipher)         │
│                       CloudUserDeviceStore (SQLCipher)         │
│                       CloudApiBaseUrl (env + Settings)         │
│                       CloudFetch (logging + 401 retry)         │
│                                                                │
│  LegacyAuthMigration (一次性 URS 清理)                          │
└────────────────────────────────┬───────────────────────────────┘
                                 │ net.fetch
                                 ▼
                         RunNode 业务云
              /app-api/member/auth/login
              /app-api/member/auth/sms-login
              /app-api/member/auth/wechat-qr
              /app-api/member/auth/wechat-login
              /app-api/member/auth/refresh-token
              /app-api/member/user/get
              /app-api/claw/user/device/*
```

### 状态机

```
                        ┌──────────────────┐
                        │  notInitialized  │  (app 刚启动，kv 未读)
                        └────────┬─────────┘
                                 │  init() 读 SQLite cloud_tokens
                                 ▼
              ┌──────────────────────────────────┐
              │  unauthenticated                 │  ◄──────────┐
              │  hasCompletedFirstLogin = false  │             │
              └────────┬─────────────────────────┘             │
                       │  login 4 种之一成功                   │
                       ▼                                        │
              ┌──────────────────────────────────┐             │
              │  authenticated                   │             │
              │  hasCompletedFirstLogin = true   │             │
              └────┬────────────────┬────────────┘             │
                   │                │                          │
            主动 logout       refresh 失败                     │
                   │       或 token 过期                       │
                   ▼                │                          │
              ┌──────────────────────────────────┐             │
              │  unauthenticated                 │ ────────────┘
              │  hasCompletedFirstLogin = true   │   LoginGate 不再拦截
              └──────────────────────────────────┘   后续操作按 RClaw 风格
                                                   requireAuth() 弹登录框
```

跟 RClaw 区别：RClaw 是 `useAuthStore.isLoggedIn` 二态，WeSight 这里拆成三态为了"首次启动必登录"这个产品决策（比 RClaw 严）。`hasCompletedFirstLogin` 持久化在 SQLite 的 `app_state` 表（key-value）。

### 4 种登录方式 + 登出 数据流

**A) 密码登录**

```
[LoginModal] 用户填 mobile + password
    │
    ▼
window.electron.cloudAuth.loginWithPassword({mobile, password})
    │
    ▼
ipcMain.handle('cloud:auth:login-password')
    │
    ▼
CloudAuthService.loginWithPassword(mobile, password)
    │  1. POST ${baseUrl}/app-api/member/auth/login
    │     headers: { 'Content-Type': 'application/json', 'tenant-id': '1' }
    │     body: { mobile, password }
    │  2. 解析响应 → { accessToken, refreshToken, expiresIn, userInfo }
    │  3. cloudAuthTokenStore.save({accessToken, refreshToken, expiresAt})
    │  4. fire-and-forget: cloudUserDeviceService.afterLogin()
    │  5. resolveUserProfile() — GET /app-api/member/user/get
    │  6. return { success, userInfo }
    ▼
返回 renderer
    │
    ▼
cloudAuthSlice.setLoggedIn({user, hasCompletedFirstLogin: true})
    │
    ▼
LoginGate 检测到 isLoggedIn=true → 卸载，进入主界面
```

**B) 短信登录**

```
[LoginModal] 用户填 mobile → 点"发送验证码"
    │
    ▼
window.electron.cloudAuth.sendSmsCode({mobile})
    │  POST ${baseUrl}/app-api/member/auth/send-sms-code
    ▼
[60s 倒计时显示给用户]
    │
    ▼ 用户填 code
window.electron.cloudAuth.loginWithSms({mobile, code})
    │  POST ${baseUrl}/app-api/member/auth/sms-login
    ▼
（同密码登录的 step 3-6）
```

**C) 微信扫码登录（polling 模式，照搬 RClaw）**

```
[LoginModal] 用户点"微信登录" tab
    │
    ▼
window.electron.cloudAuth.wechatGetQr()
    │  POST ${baseUrl}/app-api/member/auth/wechat-qr?redirectUri=...
    │  返回 { qrUrl?, ticket, expiresIn }
    ▼
[WechatQrDialog] 显示二维码（qrUrl 渲染成 <img>）+ 启动 polling
    │
    ▼ 每 2s 一次
window.electron.cloudAuth.wechatPoll({ticket})
    │  GET ${baseUrl}/app-api/member/auth/wechat-poll?ticket=...
    │  返回 { status: 'waiting' | 'scanned' | 'confirmed' | 'expired', code?, state? }
    │
    ▼ status === 'confirmed'
window.electron.cloudAuth.loginWithWechat({code, state})
    │  POST ${baseUrl}/app-api/member/auth/wechat-login
    ▼
（同密码登录 step 3-6）
```

polling 5 分钟无响应 → 报"二维码过期，请刷新"。用户点"取消" → 停 polling，关闭 dialog。

**D) 登出**

```
[Sidebar 用户菜单] 点"登出"
    │
    ▼
window.electron.cloudAuth.logout()
    │  ipcMain.handle('cloud:auth:logout')
    │  1. POST ${baseUrl}/app-api/member/auth/logout (best-effort, 失败也继续)
    │  2. cloudAuthTokenStore.clear()
    │  3. cloudUserDeviceStore.clear()
    │  4. return { success: true }
    ▼
cloudAuthSlice.setLoggedOut() — isLoggedIn = false, 但 hasCompletedFirstLogin 保留
    │
    ▼
LoginGate 已经在 hasCompletedFirstLogin=true 时不拦，所以这里只是切到主界面
后续 RunNode 操作 requireAuth() 会弹登录框
```

### Token 续期数据流（401 自动重试）

```
[任何 cloudAuthService 内的 RunNode API 调用] 走 CloudFetch
    │
    ▼
CloudFetch.doFetch(url, init)
    │  1. cloudAuthService.getValidToken()  ── 是否即将过期？
    │       │  是 (exp < 5min)
    │       ▼
    │     refreshAccessToken()  ── 合并并发：单例 promise
    │       │  POST /app-api/member/auth/refresh-token?refreshToken=...
    │       │  返回新 accessToken + 新 refreshToken（轮换）
    │       │  cloudAuthTokenStore.save(...) 覆盖
    │       │  失败 → 返回 401 给调用方
    │       │
    │  2. headers['Authorization'] = 'Bearer ' + accessToken
    │  3. net.fetch(url, init)
    │  4. response.status === 401 ?
    │       │  是
    │       ▼
    │     refreshAccessToken() 再来一次
    │       │  成功 → 重试原请求
    │       │  失败 → 返回 401 + 主进程发 'cloud:auth:logged-out' 事件
    │       ▼
    │     renderer 收到 'cloud:auth:logged-out' → setLoggedOut() + toast 提示
```

并发控制：
- `refreshInFlight: Promise<boolean> | null`（RClaw 同款）
- 多个请求同时 401 时，共享同一次 refresh，不会打多次

### 启动初始化顺序

```
1. main: app.whenReady()
2. main: legacyAuthCleanup.run()    // 删 URS 残留
3. main: SQLCipher 打开 wesight.sqlite
4. main: cloudAuthTokenStore.init()
5. main: cloudUserDeviceStore.init()
6. main: cloudUserDeviceService.init()  // 启动 main 进程 setInterval 心跳调度器
7. main: cloudApiBaseUrl.init()  // 读 VITE 编译期值 + Settings
8. main: 注册 cloud:auth:* IPC handlers（**不注册 cloud:device:*，device 服务全部在 main 内部 self-schedule，renderer 永不调**）
9. main: 创建 BrowserWindow
10. renderer: App.tsx mount
11. renderer: cloudAuthService.init()  // 读 cloud_tokens, 调 getStatus
12. renderer: hasCompletedFirstLogin ?
       │  false → 渲染 <LoginGate />  全屏覆盖
       │  true + isLoggedIn → 进主界面
       │  true + !isLoggedIn → 进主界面，Sidebar 灰掉 RunNode 入口
```

## Changes

### 新增

#### `src/main/services/cloudAuth.ts`

`CloudAuthService` 类：
- 私有字段 `refreshInFlight: Promise<boolean> | null`
- `getValidToken(): Promise<CloudTokens | null>` — 即将过期则 refresh
- `refreshAccessToken(): Promise<boolean>` — 并发合并单例
- `loginWithPassword(mobile, password): Promise<LoginResult>`
- `sendSmsCode(mobile): Promise<{ success, error? }>`
- `loginWithSms(mobile, code): Promise<LoginResult>`
- `wechatGetQr(redirectUri): Promise<{ success, qrUrl?, ticket, expiresIn }>`
- `wechatPoll(ticket): Promise<{ status, code?, state? }>`
- `loginWithWechat(code, state): Promise<LoginResult>`
  - `logout(): Promise<{ success }>`
  - `getStatus(): Promise<{ isLoggedIn, user?, hasCompletedFirstLogin }>`
  - `fetchMemberAuthorized(url, init): Promise<Response>` — 带 401 自动重试
  - 私有 `broadcastLoggedOut()`、`resolveUserProfileAfterLogin(fallback)`、`parseMemberAuthLoginBody()`、`parseMemberAuthRefreshBody()`、`readFirstLoginFlag()`（读 `app_state.has_completed_first_login`，缺省返 `false`）

> `getStatus()` 返回的 `hasCompletedFirstLogin` 必须包含：渲染层启动时调用 `getStatus()` 一次拿到这个字段，`cloudAuthSlice` 据此设初值，LoginGate 才能正确分支（`null`/`false`/`true`）。如果只让 slice 写内存里的标志、不从主进程读，会出现 LoginGate 永远停在 `<LoadingScreen />`（因为 `hasCompletedFirstLogin === null`）。

#### `src/main/services/cloudAuthTokenStore.ts`

`CloudAuthTokenStore` 类，包装 SQLCipher：

> **SQLCipher 共存策略：整库加密，不分文件。** 现有 `wesight.sqlite` 同时有 `cowork_*` / `scheduled_tasks` 等表（明文），A 实施时把底层驱动从 `better-sqlite3` 替换为 `better-sqlite3-multiple-ciphers`（是 `better-sqlite3` 的 SQLCipher fork，API 100% 兼容），整库用一把 key 加密。**不开新文件**：分开加密两个库会让 `app_state`、`kv` 跨库事务复杂化、备份/迁移要处理两个文件。**不做 mixed mode**：cipher 模式是 connection 级的，要么整库加密要么不加密。一次性迁移：第一次以 cipher key 打开时让 cipher 库自己 re-write 所有 page，**不需要手动写迁移脚本**。原有 `cowork_*` / `scheduled_tasks` 数据完整保留。
- `init()` — 建表 `cloud_tokens`（schema：accessToken、refreshToken、expiresAt，单行）
- `save(tokens: CloudTokens): Promise<void>`
- `load(): Promise<CloudTokens | null>`
- `clear(): Promise<void>`

#### `src/main/services/cloudUserDeviceService.ts`

`CloudUserDeviceService` 类：
- `init(): Promise<void>` — 读 deviceId，缺则 `uuid()` 生成；**同时启动 main 进程 `setInterval` 调度器**（5 分钟一次，调用 `heartbeat()`）。**明确不在 renderer 调度**：renderer 定时器在窗口隐藏时会被节流/暂停，丢失心跳；放在 main 进程里能跨窗口状态稳定触发。`start()` 一次后由 main 进程常驻，与 BrowserWindow 生命周期解耦。
- `afterLogin(): Promise<void>` — 登录后 fire-and-forget 调 `POST /app-api/claw/user/device/register`
- `heartbeat(): Promise<void>` — 单次心跳 `POST /app-api/claw/user/device/heartbeat`，由 main 进程的 `setInterval` 触发。**调用前先 short-circuit**：`cloudAuthTokenStore.load()` 为空时直接 return（避免登出后发无意义请求）
- `clear(): Promise<void>` — 登出时清 device store **并 `clearInterval` 停掉心跳调度器**；下一次 `init()`（重新登录后）会重启

> 把 `CloudUserDeviceService` 放在 A 而非 B/C 的理由：`claw/user/device/*` 是 RunNode 用户域的 API（RClaw 把它归在 `08_Claw_User_Device_API.md` 跟 `member/auth` 并列），属于"用户身份 + 设备维度"的紧邻概念；模型/引擎配置（B/C）不涉及设备。心跳调度器放在 main 进程也跟用户体系是同一层。

#### `src/main/services/cloudUserDeviceStore.ts`

`CloudUserDeviceStore` 类，包装 SQLCipher（与 tokenStore 共库）：
- 表 `cloud_devices`（deviceId、createdAt、lastHeartbeatAt）

#### `src/main/utils/cloudApiBaseUrl.ts`

`getCloudApiBaseUrl(): string` 函数：
- 优先读 Settings 运行时覆盖（key: `cloudApiBaseUrl`）
- 兜底读 `import.meta.env.VITE_CLOUD_API_BASE_URL` 编译期值
- 都没有 → 抛错（启动时 fail-fast，提示用户去 Settings 配）

#### `src/main/utils/cloudFetch.ts`

`cloudFetch<T>(label, url, init): Promise<T>`：
- 走 `cloudAuthService.fetchMemberAuthorized()`
- 内置 `console.debug/warn/error` 日志（WeSight 现有日志规范，不引 `cloudFetchLogged`）
- 错误抛 `CloudFetchError`（带 status / body / label）

#### `src/main/ipcHandlers/cloudAuth.ts`

注册 8 个 `ipcMain.handle`：
- `cloud:auth:login-password`
- `cloud:auth:send-sms-code`
- `cloud:auth:login-sms`
- `cloud:auth:wechat-qr`
- `cloud:auth:wechat-poll`
- `cloud:auth:login-wechat`
- `cloud:auth:logout`
- `cloud:auth:get-status`
- （加 2 个 main → renderer 的事件）：`cloud:auth:logged-out`、`cloud:auth:login-success`

> **不创建 `src/main/ipcHandlers/cloudUserDevice.ts`**：`CloudUserDeviceService.afterLogin()` 和 `heartbeat()` 都在 main 进程内部触发（前者 fire-and-forget 自 `CloudAuthService.login*`，后者由 `setInterval` 调度），renderer 永远不调。建 IPC handler 是死代码。

#### `src/main/migrations/legacyAuthCleanup.ts`

`legacyAuthCleanup.run(): Promise<void>`：
- 检测 `auth_tokens` kv 存在 → 删除（URS OAuth 残留）
- 检测 `server_models_meta` kv 存在 → 删除（**此 kv 由 URS 时代的 `auth:getModels` IPC handler 写入，存的是 URS 服务端模型列表快照**；属于 URS 时代数据，A 阶段硬清。B 实施时需要重新设计 server-models 持久化方案并用新 key 写入，例如 `cloud_server_models_meta`）
- 在 main.ts 里 `console.log('[Migration] URS legacy auth state cleared')`（一次性）
- 通过 `app_state` 表写一个标记 `urs_cleanup_at = <ISO>`

#### `src/renderer/services/cloudAuth.ts`

替换 `src/renderer/services/auth.ts`：
- 4 个登录方法 + logout + getStatus + getUser
- `requireAuth()` — 弹 LoginModal
- 监听 `cloud:auth:logged-out` 事件
- 调 `cloudAuthSlice` dispatch

#### `src/renderer/store/slices/cloudAuthSlice.ts`

替换 `src/renderer/store/slices/authSlice.ts`：
- state: `{ isLoggedIn, user, hasCompletedFirstLogin, isLoading }`
- 同步方法：`setLoggedIn`、`setLoggedOut`、`setLoading`、`setHasCompletedFirstLogin`
- 移除 `quota`、`profileSummary`（那是 B 的事，本 spec 不做）

#### `src/renderer/components/LoginGate.tsx`

```tsx
export function LoginGate({ children }) {
  const { isLoggedIn, hasCompletedFirstLogin } = useSelector((s) => s.cloudAuth);
  
  if (hasCompletedFirstLogin === null) return <LoadingScreen />;
  if (!hasCompletedFirstLogin) return <FirstRunLoginScreen />;
  if (!isLoggedIn) return <>{children}<LoginModal />;  // 透明叠加
  return <>{children}</>;
}
```

#### `src/renderer/components/LoginModal.tsx`

**3 个 tab**（密码 / 短信 / 微信扫码）。**注册走"去注册"内联链接，不放 tab**：登录失败（密码错、短信码错等）时，错误红条下方显示一行链接 "去 RunNode Portal 注册 →"，点击用 `shell.openExternal()` 打开 `${baseUrl}/register` 路径。60s 短信倒计时。错误顶部红条。

#### `src/renderer/components/WechatQrDialog.tsx`

显示二维码 + 状态轮询。`waiting` → 显示"请扫码"；`scanned` → "已扫码，请在手机上确认"；`expired` → "已过期，请刷新"。

超时控制：组件 mount 时启动一个 `useEffect` 内的 `setTimeout(5 * 60 * 1000)`，5 分钟后无论 polling 状态如何都强制 close + 显示"二维码已过期"提示 + 提供"刷新二维码"按钮（重新调 `wechatGetQr`）。组件 unmount 时 `clearTimeout` 取消。

#### `src/shared/cloudAuth/constants.ts`

```ts
export const CloudAuthChannel = {
  LoginPassword: 'cloud:auth:login-password',
  SendSmsCode: 'cloud:auth:send-sms-code',
  LoginSms: 'cloud:auth:login-sms',
  WechatQr: 'cloud:auth:wechat-qr',
  WechatPoll: 'cloud:auth:wechat-poll',
  LoginWechat: 'cloud:auth:login-wechat',
  Logout: 'cloud:auth:logout',
  GetStatus: 'cloud:auth:get-status',
  LoggedOutEvent: 'cloud:auth:logged-out',
  LoginSuccessEvent: 'cloud:auth:login-success',
} as const;
export type CloudAuthChannel = typeof CloudAuthChannel[keyof typeof CloudAuthChannel];

export const CloudLoginMethod = {
  Password: 'password',
  Sms: 'sms',
  Wechat: 'wechat',
} as const;
export type CloudLoginMethod = typeof CloudLoginMethod[keyof typeof CloudLoginMethod];
```

#### `.env.example`

新增：
```
VITE_CLOUD_API_BASE_URL=https://api.runnode.example.com
```

#### `vite.config.ts`

确保 `VITE_CLOUD_API_BASE_URL` 通过 `define` 注入编译期。

#### `package.json` deps

- `@journeyapps/sqlcipher` 或 `better-sqlite3-multiple-ciphers`（用哪个走 Plan 阶段拍板）
- `uuid`（已有）
- `node-machine-id` 用于派生 SQLCipher 加密 key（`sha256("WeSight-CloudDB-v1\0" + machineId + appName)`），保证 DB 文件不能被简单复制到另一台机器解开。**不引 `node-machine-id` 之外的额外 keytar**，避免原生绑定。

### 删除

| 文件/位置 | 原因 |
|---|---|
| `src/renderer/services/auth.ts`（整个） | URS 旧服务 |
| `src/renderer/store/slices/authSlice.ts`（整个） | URS 旧 slice |
| `src/renderer/components/LoginButton.tsx`（整个） | 整体重写为 LoginModal + LoginGate |
| `src/main/main.ts` 中 `auth:login/exchange/getUser/getQuota/getProfileSummary/refreshToken/getAccessToken/getModels/logout` 9 个 handler | URS IPC |
| `src/main/main.ts` 中 `registerOAuthProtocol()` | URS deep link |
| `src/main/main.ts` 中 `ensureDesktopAuthCallbackUrl()` + `desktopAuthCallbackServer` + `pendingAuthCode` 缓冲 | URS local HTTP callback |
| `src/main/main.ts` 中 macOS `open-url` 监听 + `second-instance` 里的 `wesight://` 处理 | URS deep link |
| `src/main/sqliteStore.ts` 中 `saveAuthTokens/getAuthTokens/clearAuthTokens` 3 个 helper | URS token 存储 |
| `src/main/main.ts` 中 `normalizeQuota` 函数 | URS quota 规范化（B 才需要） |
| `src/main/main.ts` 中 `auth:quotaChanged` 事件发送 | B 才需要 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/renderer/App.tsx` | `authService.init()` → `cloudAuthService.init()`；外层套 `<LoginGate>`；删 `onShowLogin` 调用链（Sidebar 改用 cloudAuthSlice） |
| `src/renderer/components/Sidebar.tsx` | 用户菜单 / 登录入口改读 `cloudAuthSlice`；删 `hideLogin` prop（已不适用） |
| `src/main/main.ts` | 在 `app.whenReady()` 早期调 `legacyAuthCleanup.run()`；删所有 `auth:*` handler + deep link 注册；新增 `cloud:auth:*` 注册（**device 服务无 IPC handler**） |
| `src/renderer/services/i18n.ts` | 新增 key：`authCloud*`、`authMethodPassword` / `authMethodSms` / `authMethodWechat`、`authWechatWaiting` / `authWechatScanned` / `authWechatExpired`、`authSmsCountdown`、`authCloudLoggedOutToast`、`authCloudFirstRunTitle` 等；删除 `authPlanFree` / `authPlanStandard` / `authPlanAdvanced` / `authPlanPro` / `authQuotaExhausted` / `authCreditsUnit` / `authExpiresAt` 等（B 才需要） |
| `src/renderer/services/config.ts` | 新增 `cloudApiBaseUrl` 字段（用户可在 Settings 改） |
| `src/renderer/components/Settings/CloudApiSection.tsx` | 新增 Settings 区块：RunNode API 地址输入框 + "测试连接"按钮（走 main 进程 `probeCloudBaseUrl()`：故意用缺字段的 POST 请求探活，4xx 视为"已连通"、网络 reject 视为"失败"）+ "保存"按钮（写回 `configService.cloudApiBaseUrl`，下次 `getCloudApiBaseUrl()` 调用即生效） |
| `electron-builder.json` | 确保 native module（SQLCipher）打进去 |
| `package.json` scripts | `pretest` 加 `electron-rebuild`（如果用 native sqlcipher） |

## Testing

### 单元测试（Vitest，`*.test.ts` 同目录）

| 文件 | 覆盖 |
|---|---|
| `cloudAuth.test.ts` | `getValidToken` 过期判定；`refreshAccessToken` 并发合并单例；4 种登录的响应解析 |
| `cloudAuthTokenStore.test.ts` | SQLCipher 加解密的 save/load/clear 闭环；损坏数据降级到 null |
| `cloudUserDeviceService.test.ts` | `init` 后生成 deviceId；`afterLogin` fire-and-forget；`clear` 行为 |
| `cloudApiBaseUrl.test.ts` | Settings 覆盖优先级；env 兜底；都没 → 抛错 |
| `cloudFetch.test.ts` | 401 → refresh → 重试；refresh 失败 → 抛错 |
| `parseMemberAuthLoginBody.test.ts` | 各种响应形状（标准、扁平、旧字段名） |
| `parseMemberAuthRefreshBody.test.ts` | refresh 响应形状（带新 refreshToken 轮换 / 不带轮换 / 错误码） |

### 集成测试（Vitest + mock net.fetch）

- 完整登录流程：密码登录 → 持久化 → 模拟"下次启动"读 SQLite → 自动恢复登录
- 401 → refresh → 重试：mock 第一次 401、第二次 200
- refresh 失败：mock refresh 返 500 → 触发 `cloud:auth:logged-out` 事件

### 组件测试（Testing Library + Vitest）

| 文件 | 覆盖 |
|---|---|
| `LoginModal.test.tsx` | 3 tab 切换（密码 / 短信 / 微信扫码）；60s 倒计时归零；错误信息顶部红条展示；登录失败时"去注册"内联链接可见 |
| `WechatQrDialog.test.tsx` | polling 状态机：`waiting` → `scanned` → `confirmed` 跳转；`expired` 按钮可用 |
| `LoginGate.test.tsx` | 首次启动 → 显示全屏；登录后 → 渲染 children；登出 → 弹 LoginModal |

### 端到端（Playwright）

`tests/e2e/auth.spec.ts`：
1. 启动应用 → 看到 LoginGate 全屏 → 密码登录成功 → 进入主界面
2. 杀掉应用 → 重启 → 自动恢复登录（不显示 LoginGate）
3. 模拟 token 过期 → 401 → refresh 失败 → 弹出 LoginModal

### 手动 smoke

- macOS arm64 / x64 各跑一次首次启动
- 跨平台 SQLCipher 编译验证（macOS / Windows / Linux 三平台 Phase 1 跑通）

## Error Handling

| 错误类型 | 来源 | 处理 |
|---|---|---|
| 网络层 | `net.fetch` reject | toast "网络异常"；不重试 |
| 业务层 4xx 鉴权类 | 401 / 403 | 401：refresh + 重试（一次）；refresh 失败 → `cloud:auth:logged-out` + 弹登录框；403：toast |
| 业务层 4xx 参数类 | 400 / 422 | 透传 `error` 字段，LoginModal 顶部红条 |
| 业务层 5xx | 500/502/503 | toast "服务暂时不可用"；不重试；log error |
| Token 即将过期 | 客户端 | 主动 refresh，调用方无感 |
| Token 已过期 | 401 | refresh 成功 → 透明；refresh 失败 → `cloud:auth:logged-out` |
| 设备心跳失败 | network 5xx / timeout | `cloudUserDeviceService.heartbeat()` catch 异常，**仅 `console.warn` + 等下一周期重试**；不抛错、不重试当前次、不影响登录态。RunNode 端的设备 deregistration 容忍策略不在 A 范围。 |
| 微信 QR 过期 | 5min 无响应 / `expired` | "刷新二维码"按钮 |
| 首次启动 SQLite 损坏 | `cloud_tokens` 读不出 | `legacyAuthCleanup` 兜底清表 + 走 `unauthenticated` |
| baseUrl 配错 | 所有 RunNode API 5xx/4xx | Settings 加"测试连接"按钮；启动不阻塞 |

## Out of Scope

明确**不在 A 解决**：

- ❌ `coin` / `subscriptionPlan` 展示 → **B**
- ❌ RunNode 模型 → 本地 engine 的 baseUrl/apiKey 同步 → **C**
- ❌ Claw Catalog 拉取与数字员工 → **D**
- ❌ 第三方 IM 通道（DingTalk / Feishu 等）的 RunNode 集成
- ❌ 新会员注册流程（`/app-api/member/auth/register`）→ 登录失败时给出"去注册"链接
- ❌ 找回密码（`/auth/reset-password`）→ 给出"去 Portal 找回"链接
- ❌ 修改手机号 / 修改密码 → 全走 Portal

## Known Risks

- ⚠️ **SQLCipher 跨平台编译**：`@journeyapps/sqlcipher` 或 `better-sqlite3-multiple-ciphers` 都需 native module，6 个目标平台（macOS arm64/x64、win-x64/win-arm64、linux-x64/linux-arm64）都得 `electron-rebuild`。**Phase 1 跑通 macOS arm64 + x64，Windows / Linux 排到 Phase 2。**
- ⚠️ **RunNode baseUrl 没正式公开**：`VITE_CLOUD_API_BASE_URL` 是占位；A 完成后需要业务方给正式地址。
- ⚠️ **`subscriptionPlan` 字段名映射**：RClaw 拿到的是 `FREE / Plus / Pro`，但 WeSight 现有 i18n 是"免费/标准/进阶/专业"4 个值；B 实施时需要做 i18n key 映射表。
- ⚠️ **微信 polling 后端契约**：`/app-api/member/auth/wechat-qr` 和 `/wechat-poll` 的具体响应字段需要跟 RunNode 业务方确认；spec 写的是 RClaw 推论。
- ⚠️ **设备心跳频率**：RClaw 没明确 heartbeat 间隔，spec 默认 5 分钟，需要跟业务方确认。

## Migration Path

**硬重置**（用户决定：clean_break）：
1. 启动时若 `app_state.urs_cleanup_at` 缺失 → 触发 `legacyAuthCleanup.run()`。`run()` 内部按 kv 存在性逐项删除（idempotent）：`auth_tokens`、`server_models_meta`，最后写 `urs_cleanup_at = <ISO>` 标记完成；之后 `app_state.urs_cleanup_at` 存在则跳过（避免重复）
2. 删 deep link handler 注册（不再需要 `wesight://` 协议）
3. 用户第一次启动 A 完成后看到 LoginGate → 重新登录 RunNode
4. 旧的 URS 账号无法迁移（URS 与 RunNode 是两套用户体系，business decision：强行迁移意义不大）

## Open Questions

实施前需跟业务方确认：

1. RunNode 业务云正式 baseUrl 是？
2. 微信扫码：`/wechat-qr` 是否需要 `redirectUri`？轮询接口是 `/wechat-poll` 还是别的？
3. 设备心跳频率？
4. 登录后是否需要主动调 `cloudUserDeviceService.afterLogin()`？RClaw 是这样做的但要确认 WeSight 是否也要。
5. SQLCipher 选 `@journeyapps/sqlcipher` 还是 `better-sqlite3-multiple-ciphers`？需要看 WeSight 现有 `better-sqlite3` 12.x 是否能 smooth 替换。
