# @prism/server

PRiSM Next 统一服务端核心程序包（Unified Platform Server）。

本包整合了 PRiSM 的平台管理、多租户单店业务、设备控制、实时计费推送以及 Cloudflare Worker 部署入口，提供高性能、纯 TypeScript、直连架构的现代化服务端运行时。

## 架构概览

```
packages/server/
├── src/
│   ├── app.ts                          # 顶层 Hono 应用实例组装 (createApp)
│   ├── worker.ts                       # Cloudflare Worker 运行时入口 (fetch / scheduled)
│   ├── index.ts                        # 统一导出
│   ├── bindings.ts                     # 环境契约类型 (Env, AppBindings, AuthUser)
│   ├── deployment-gate.ts              # 零停机热升级门禁 (Deployment Gate & Control)
│   ├── durable-objects/
│   │   ├── live-billing.ts             # Apple Live Activity 实时活动 Durable Object (LiveBilling)
│   │   ├── live-activity-billing.ts    # 实时活动账单计算器
│   │   └── live-activity-push.ts       # APNs 推送传输客户端
│   ├── tasks/
│   │   └── cron-handlers.ts            # 定时任务处理与过期数据归档清理 (purgeExpiredPlatformState)
│   ├── migrations/
│   │   └── shop-time-zone-migration.ts # 店铺地理位置与时区自动化数据迁移
│   ├── routes/
│   │   ├── platform/                   # 平台级接口 (auth, passkeys, user, shops)
│   │   ├── shops/                      # 多租户店铺级业务接口 (/api/v1/shops/:shopCode)
│   │   ├── system/                     # 系统级探针接口 (/health, /version)
│   │   └── web-assets.ts               # SPA 静态前端资源分发与回退
│   ├── legacy/                         # 单店向下兼容路由与自动租户回退层
│   ├── middleware/                     # 核心中间件栈 (cors, auth, tenant, rate-limit, geo, response-time)
│   ├── hardware/                       # 硬件网关驱动 (Hinata IO, Home Assistant, TTLock, WebSocket)
│   └── crypto.ts                       # 密码学与安全工具
└── test/
    ├── worker-entrypoint.test.ts       # 顶层应用路由分发、Worker 生命周期与 Cron 调度测试
    ├── shop-billing-routes.test.ts     # 多租户单店计费核心流程测试
    ├── legacy-api.test.ts              # 兼容层重定向与废弃标头测试
    ├── platform-routes.test.ts         # 平台认证与商户管理测试
    └── middleware.test.ts              # 中间件安全与租户解析测试
```

## 核心设计与模块

### 1. 顶层应用装配 (`app.ts`)

- `createApp()`: 构造全新的根 Hono 实例。
- **全局中间件**：
  - `corsMiddleware`: 严格的白名单校验与跨域预检。
  - 请求计时：动态追加 `x-response-time` 标头。
  - `attachUser`: 从 Cookie 或 Bearer Token 解析当前用户会话。
  - `serveWebAssets()`: 对非 API 请求代理到 `c.env.ASSETS`（支持 SPA HTML 回退）。
- **统一错误处理**：
  - `PrismDomainError`: 结构化领域错误映射为对应的 HTTP 状态码（400, 404, 409）。
  - `z.ZodError`: 参数校验失败映射为 422 `VALIDATION_FAILED`。
  - `HTTPException`: 遵循标准 Hono 异常响应。
- **路由分发树**：
  - `/health`, `/api/v1/health`: 系统健康检查。
  - `/version`, `/api/v1/version`: 部署版本与 Git 修订号。
  - `/api/v1/auth`, `/api/v1/passkeys`, `/api/v1/user`, `/api/v1/account`: 平台认证与账号。
  - `/api/v1/merchant/shops`, `/api/v1/shops`: 平台级商户店铺管理。
  - `/api/v1/shops/:shopCode`: 多租户店铺业务核心（玩家、店员、收银、机台、计费、资产）。
  - `/`: 挂载 `legacyRouter` 承接旧版单店客户端请求，自动注入废弃标头（`Deprecation: true`）与租户解析。

### 2. Cloudflare Worker 运行时入口 (`worker.ts`)

- `export default { fetch, scheduled }`: 兼容 Cloudflare Workers 原生标准。
- `export { LiveBilling }`: 导出 Live Activity 实时活动 Durable Object。
- **热升级门禁检查**：
  - `deploymentControl`: 承接部署管道的探针与原子迁移指令（`/__prism_deploy`）。
  - `isDeploymentMaintenance`: 维护或校验阶段自动返回 503 与重试建议。
- **静态资源直通**：
  - 在存在 `env.ASSETS` 时直通静态文件请求，绕过 D1 数据库查询。
- **监控与修订号标头**：
  - 自动向健康检查接口追加 `x-prism-revision` 标头。
  - 慢请求或异常请求上报结构化指标日志。

### 3. Apple 实时活动 Durable Object (`durable-objects/live-billing.ts`)

- 管理 iOS 实时活动（Live Activity）推送。
- `LiveBilling.refresh(shopId, playerId)`: 防抖合并不必要的重复计算，设置延迟闹钟。
- `LiveBilling.alarm()`:
  - 校验有效 Push Token 并批量清理过期 Token。
  - 依据最新账单（`activityBill`）合成 APNs 更新或结束 Payload。
  - 支持指数退避重试（最多 6 次），避免对 APNs 服务器造成风暴。

### 4. 自动化任务与数据清理 (`tasks/cron-handlers.ts`)

- `purgeExpiredPlatformState(env)`: 定时清理已过期的临时机台凭证（`machine_tickets`）、登录挑战（`auth_challenges`）、闲置会话（`auth_sessions`）、绑定验证码（`platform_binding_codes`）及操作锁（`operation_locks`）。
- 每次批量限制最多 500 行，避免大事务锁表。
- 维护模式期间自动跳过定时清理。

### 5. 店铺时区数据迁移 (`migrations/shop-time-zone-migration.ts`)

- `migrateShopLocationTimeZones(db)`:
  - 幂等执行检查（基于 `prism_data_migrations` 记录表）。
  - 根据各店铺配置的经纬度坐标，通过 `resolveLocationTimeZone` 自动推导并保存本地展示时区，确保跨时区经营场所账务日历准确无误。

## 常用测试命令

```bash
# 运行 Worker 入口测试
bun test packages/server/test/worker-entrypoint.test.ts

# 运行 server 包全量测试
bun test packages/server

# 项目级类型检查
bun run typecheck
```
