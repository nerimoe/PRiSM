# PRiSM Server Routes (`packages/server/src/routes`)

本目录包含 `@prism/server` 的路由层实现，分为平台级路由（Platform Routes）、系统级路由（System Routes）以及静态资源处理路由（Web Assets）。

## 目录结构

```
routes/
├── index.ts                # 导出所有路由及相关类型
├── platform/               # 平台级与用户级路由
│   ├── auth.ts             # 登录、注册、退出与会话管理
│   ├── passkeys.ts         # WebAuthn Passkey 挑战生成、校验与设备管理
│   ├── user.ts             # 当前用户信息、多身份绑定与账号 Passkey 管理
│   └── shops.ts            # 店铺创建、查询、更新、封面与删除管理
├── system/                 # 系统级路由
│   ├── health.ts           # 健康检查接口 (/health, /api/v1/health)
│   └── version.ts          # 版本与修订号接口 (/version, /api/v1/version)
└── web-assets.ts           # SPA 静态前端资源分发与回退路由
```

## 路由规范

### 1. 平台认证路由 (`/api/v1/auth`)

- `POST /register`: 用户注册，创建本地认证身份并建立会话 Cookie。
- `POST /login`: 用户登录，校验账号状态并建立会话 Cookie。
- `POST /logout`: 退出登录，注销当前会话并清除 Cookie。
- `GET /me`: 获取当前登录用户基础状态。
- 子路由 `/passkey`:
  - `GET /options`: 获取 WebAuthn 认证挑战参数（含防刷频限流）。
  - `POST /`: 校验 Passkey 认证结果并建立用户会话。
  - `GET /register/options`: 获取 WebAuthn 凭证注册挑战（需登录）。
  - `POST /register`: 校验并保存新 Passkey 凭证（需登录）。

### 2. 平台用户与账号路由 (`/api/v1/user`, `/api/v1`)

- `GET /me` / `GET /`: 获取当前用户资料及商户店铺归属标识 (`hasShops`)。
- `GET /account`: 获取用户绑定的所有外部第三方身份（如 MuNET）与已登记 Passkey 列表。
- `DELETE /account/passkeys/:id` / `DELETE /passkeys/:id`: 注销指定 Passkey 凭证。
- `PATCH /account/passkeys/:id` / `PATCH /passkeys/:id`: 重命名 Passkey 设备备注名。

### 3. 平台商户店铺路由 (`/api/v1/shops`, `/api/v1/merchant/shops`)

- `GET /`: 获取当前用户有权管理的店铺列表（管理员可查看全量店铺）。
- `POST /`: 新建店铺。支持设置经纬度、地理围栏半径、时区自动判定（`resolveLocationTimeZone`）、初始账务配置（`billingSetup`）及 Bot 对接 Token。
- `GET /:id`: 根据店铺 UUID 或 8 位公开标识 `public_id` 查询店铺公开属性。
- `GET /:publicId/hero`: 获取店铺封面图二进制数据，支持基于 `ETag` 和 `If-None-Match` 的 304 强缓存。
- `PATCH /:id`: 修改店铺名称、定位坐标、围栏半径及封面（仅所有者或管理员可用）。
- `DELETE /:id`: 删除店铺。具有业务流水或玩家记录的店铺禁止删除（返回 409 `SHOP_HAS_HISTORY`）。

### 4. 系统运行状态路由

- `/health` / `/api/v1/health`: 返回系统健康状态 (`ok: true`, `service: "prism-api"`), 部署阶段包含 `x-prism-revision` 标头。
- `/version` / `/api/v1/version`: 返回服务版本号、部署修订号及运行时依赖版本信息。

### 5. 静态资源路由 (`web-assets.ts`)

- 通过 `serveWebAssets` 中间件与 `webAssetsRouter` 路由分发 Cloudflare `ASSETS` 静态页面与构建产物。
- 自动避开所有 `/api/`、`/.well-known/`、`/callback` 等动态服务路径。
- 在维护阶段（`PRISM_DEPLOY_PHASE === 'maintenance'`）自动拦截。
- 支持针对 HTML 页面请求回退至 SPA 根入口 (`/`)。
