# PRiSM 后端架构深度合并与 `@prism/server` 统一设计规范

- **状态**: 待执行 (Approved by User, Ready for Planning)
- **日期**: 2026-10-08
- **责任模块**: `packages/server` (新建), `packages/application` (消歧义重构), `packages/platform` (废弃合并), `packages/runtime` (废弃合并), `packages/server-hono` (废弃合并)

---

## 1. 背景与重构目标

### 1.1 历史背景与现状痛点
在项目历史演进中，PRiSM Next（单店版离线计费核心）与 ArcadeLink（多租户云端平台）进行了初步合并（参见 `docs/platform-merge.md`），但在架构层面遗留了明显的割裂：

1. **虚拟 HTTP 转发开销与断层调用栈**：
   在 `packages/platform/src/billing.ts` 中，所有针对店铺级计费的请求（`/api/v1/shops/:shopCode/player/*`、`/staff/*`、`/integration/*`）都通过构造虚拟的 `new Request()`，并调用 `createPrismApp(deps).fetch(request)` 进行二次分发。这造成了两次路径匹配、双重 JSON 序列化/反序列化，以及在排查故障时被割裂的堆栈信息。
2. **三包职责混乱与重复**：
   - `packages/server-hono`：定义了旧版单店模式的 Hono 路由与视图转换。
   - `packages/runtime`：定义了旧版 Worker 入口、本地 Bun 运行入口以及一套硬件驱动执行器（`ttlock-executor`, `home-assistant-executor`, `hinata-io-executor`）。
   - `packages/platform`：定义了多租户平台的 Worker 入口、另一套硬件驱动逻辑以及所有平台 API。
3. **双入口与双 Wrangler 配置**：
   同时存在 `packages/runtime/src/worker.ts` 与 `packages/platform/src/worker.ts`，以及 `wrangler.platform.jsonc` 与 `wrangler.generated.jsonc`，导致部署脚本与开发者心智负担极大。
4. **跨包同名文件引起的混淆**：
   `packages/core` 与 `packages/application` 中存在多组同名文件（如 `settlement.ts`, `redeem.ts`），容易使维护者误认为是合并冲突产生的文件重复，且在 IDE 中自动导入时容易选错。

### 1.2 重构核心目标
1. **深度合并为单一服务端包**：
   将 `packages/server-hono`、`packages/runtime`、`packages/platform` 彻底合并为统一的 **`packages/server`**（包名 `@prism/server`），完全废除前三者。
2. **纯原生 Hono 路由直通**：
   使用标准 Hono 子路由系统（Sub-routers）替代虚拟 HTTP forward 转发。店铺级路由通过轻量级 `tenantMiddleware` 注入店铺上下文与领域服务依赖，直接调用用例处理函数。
3. **旧版 API 集中隔离管理**：
   旧版单店 API 统一收归于 `packages/server/src/legacy/` 目录下，在本地单机环境默认映射到单店作用域，在云端提供兼容 fallback 与废弃响应头（Deprecation Headers），并提供详细的集中迁移文档。
4. **统一双环境入口**：
   收拢为唯一的 Cloudflare Worker 入口 `packages/server/src/worker.ts` 和唯一的 Bun 本地独立运行入口 `packages/server/src/serve.ts`，配置统一归拢至 `wrangler.jsonc`。
5. **消除重复实现与文件名消歧义**：
   合并重复的硬件驱动逻辑，并将 `packages/application/src/settlement.ts`、`redeem.ts` 明确重命名为 `settlement-service.ts`、`redeem-service.ts`，保持领域层与应用层的清晰边界。

---

## 2. 目标架构与模块目录设计

### 2.1 目标包结构：`packages/server`

```text
packages/server/
├── package.json                   # @prism/server
├── tsconfig.json
├── src/
│   ├── index.ts                   # 导出 serverApp 及核心类型
│   ├── worker.ts                  # 🌐 统一 Cloudflare Worker 入口 (D1, DO, Assets, Crons)
│   ├── serve.ts                   # 💻 统一 Bun 本地独立运行入口 (Bun.serve, SQLite, WS)
│   ├── local-server.ts            # 本地 Bun 依赖初始化与生命周期
│   │
│   ├── app.ts                     # 顶层 Hono 应用实例组装 (中间件、各子路由挂载)
│   ├── bindings.ts                # Cloudflare Env & Hono 上下文变量强类型定义
│   │
│   ├── middleware/                # 全局与通用中间件
│   │   ├── auth.ts                # 平台统一 Session / Bearer Token 认证
│   │   ├── tenant.ts              # :shopCode 租户解析与店铺上下文注入
│   │   ├── rate-limit.ts          # Cloudflare / 本地防刷限流中间件
│   │   ├── cors.ts                # 严密跨域中间件 (禁止通配反射凭证)
│   │   ├── geo.ts                 # 店铺地理围栏校验
│   │   └── response-time.ts       # 响应体时间格式本地化投影 (由旧 api-time 重构而来)
│   │
│   ├── routes/                    # 现代化多租户标准子路由
│   │   ├── platform/              # 平台级别路由
│   │   │   ├── auth.ts            # 登录、注册、注销、Passkeys
│   │   │   ├── user.ts            # 平台用户信息
│   │   │   └── shops.ts           # 店铺创建、查询、加入申请
│   │   ├── shops/                 # 店铺作用域路由 (/api/v1/shops/:shopCode/*)
│   │   │   ├── player.ts          # 玩家端业务 (会话、资产、投币、结账预览与确认)
│   │   │   ├── staff.ts           # 员工管理端业务 (玩家管理、资产调整、报表)
│   │   │   ├── integration.ts     # 机器人与第三方系统集成 (AstrBot, Koishi)
│   │   │   ├── devices.ts         # 硬件设备管理与状态监控
│   │   │   ├── pricing.ts         # 计费规则管理与 SVG 24h 时间轴预览
│   │   │   ├── assets.ts          # 货币与资产定义管理
│   │   │   ├── redeem.ts          # 兑换券与礼品核销
│   │   │   └── cashier.ts         # 吧台现场收银功能
│   │   ├── system/                # 系统级路由
│   │   │   ├── health.ts          # /health 健康检查
│   │   │   └── version.ts         # /version 版本信息
│   │   └── web-assets.ts          # 静态前端资源兜底托管 (ASSETS 绑定)
│   │
│   ├── legacy/                    # ⏳ 旧版单店 API 集中管理目录
│   │   ├── README.md              # 📖 旧 API 清单、废弃声明与迁移指南
│   │   ├── router.ts              # 旧版路由入口 (挂载 /api/v1/player/* 等无 shopCode 路径)
│   │   ├── middleware.ts          # Deprecation Header 注入与访问告警日志
│   │   ├── tenant-resolver.ts     # 请求头/参数/单店默认租户解析器
│   │   ├── handlers/              # 直接复用 core/application 的旧版处理器
│   │   │   ├── player.ts
│   │   │   ├── staff.ts
│   │   │   ├── integration.ts
│   │   │   └── setup.ts
│   │   └── rpc-fallback.ts        # /rpc/* 友好弃用提示
│   │
│   ├── hardware/                  # 🔌 统一硬件执行驱动 (彻底消除平台与运行时的双重实现)
│   │   ├── hinata.ts              # Hinata-IO (E2EE Aime 刷卡与按键投币，合并旧 hinata-io-executor)
│   │   ├── ttlock.ts              # TTLock 门锁云接口与本地蓝牙网关执行器
│   │   ├── home-assistant.ts      # Home Assistant 实体开关与状态轮询
│   │   └── machine-ws.ts          # 物理机位 WebSocket 协议引擎
│   │
│   ├── durable-objects/           # Cloudflare Durable Objects 状态管理
│   │   └── live-billing.ts        # LiveBilling DO 实时账单聚合
│   │
│   ├── tasks/                     # 定时调度任务 (Scheduled Handler)
│   │   └── cron-handlers.ts       # 超时未支付账单关闭、会话状态巡检
│   │
│   └── migrations/                # 平台级迁移脚本
│       └── shop-time-zone-migration.ts # 消除与 core/location-time-zone 撞名的迁移
│
└── test/                          # 统一服务器测试套件
```

---

## 3. 路由与依赖注入（DI）模型

### 3.1 消除虚拟 HTTP Forward
* **现状**：
  ```ts
  // ❌ 现状：构造虚拟 Request 二次进入 Hono
  const request = new Request(url, { method, headers, body });
  const response = await createPrismApp(deps).fetch(request);
  ```
* **目标规范**：
  直接挂载 Hono 级联子路由，依赖通过 `c.set("deps", deps)` 注入：
  ```ts
  // ✅ 目标：原生 Hono 嵌套路由
  const shopRouter = new Hono<AppBindings>();
  shopRouter.use("*", tenantMiddleware);
  shopRouter.route("/player", playerRouter);
  shopRouter.route("/staff", staffRouter);
  shopRouter.route("/integration", integrationRouter);
  shopRouter.route("/devices", devicesRouter);

  app.route("/api/v1/shops/:shopCode", shopRouter);
  ```

### 3.2 `tenantMiddleware` 依赖按需装配
对于进入特定店铺的请求，`tenantMiddleware` 负责：
1. 从 URL `:shopCode` 读取标识并在数据库查询店铺基本信息（缓存至内存或弱引用）。
2. 装配该店铺的 `@prism/application` 依赖容器（包含 D1/SQLite Repositories、锁机制、硬件解析器）。
3. 将 `shop` 实体与 `deps` 放入 Hono 的 `Context` 变量中供下游直接消费，无需重复创建。

---

## 4. 旧版单店 API 集中管理与迁移规范

### 4.1 目录隔离与端点范围
所有无 `:shopCode` 前缀的旧单店接口（包括 `/api/v1/staff/*`, `/api/v1/player/*`, `/api/v1/player-auth/*`, `/api/v1/bot/*`, `/api/v1/integration/*`, `/api/v1/setup/*`, `/rpc/*`）统一收录至 `packages/server/src/legacy/`。

### 4.2 租户映射规则（Tenant Resolution for Legacy）
1. **本地环境（Bun.serve）**：默认自动映射至单店 ID `default`。
2. **多租户云端环境（Worker）**：
   - 提取请求头 `X-PRiSM-Shop` 或 `X-Shop-Id`；
   - 提取 Query 参数 `?shopCode=...`；
   - 环境变量 `DEFAULT_FALLBACK_SHOP`；
   - 若均未提供且存在多家店铺，返回 `400 Bad Request`，并在响应体明确提供迁移指引。

### 4.3 废弃元数据与追踪
命中 `legacyRouter` 的响应自动附加标头：
```http
X-API-Deprecated: true
X-API-Sunset: 2027-01-01
Link: </api/v1/shops/{shopCode}/...>; rel="successor-version"
```
并在控制台输出一次带有限流的告警日志。

---

## 5. 双运行环境与构建配置

### 5.1 Cloudflare Worker 统一入口 (`src/worker.ts`)
```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return serverApp.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduledTasks(event, env, ctx);
  }
};
export { LiveBilling } from "./durable-objects/live-billing";
```

### 5.2 Bun 本地独立运行入口 (`src/serve.ts`)
```ts
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  fetch(req, server) {
    if (server.upgrade(req, { data: { /* ws context */ } })) return;
    return localServerApp.fetch(req);
  },
  websocket: machineWebSocketHandler,
});
```

### 5.3 构建与部署配置统一
1. **Wrangler 配置合并**：
   废除 `wrangler.platform.jsonc` 与 `wrangler.generated.jsonc`，合并为单一 `wrangler.jsonc`，其 `main` 字段固定指向 `"packages/server/src/worker.ts"`。
2. **根目录 `package.json` Workspaces**：
   ```json
   "workspaces": [
     "packages/adapter-d1",
     "packages/adapter-sqlite",
     "packages/application",
     "packages/core",
     "packages/migration",
     "packages/server",
     "packages/storage-sql",
     "packages/prism-web"
   ]
   ```
3. **Npm Scripts 精简统一**：
   - `bun run dev:local`: 本地极速 Bun + SQLite 启动。
   - `bun run dev:worker`: 本地 Miniflare D1 边缘模拟启动。
   - `bun run dev:all`: 启动 Worker + 前端 Vite + AstrBot。
   - `bun run check:server`: 替代旧 `check:platform`。
   - `bun run deploy:worker`: 部署统一平台 Worker。

---

## 6. 代码重复消除与文件命名规范（消歧义）

为消除历史合并遗留的代码重复与 IDE 导入混淆，做出如下明确改动：

1. **`packages/application` 命名消歧义**：
   - 将 `packages/application/src/settlement.ts` 重命名为 **`settlement-service.ts`**。
   - 将 `packages/application/src/redeem.ts` 重命名为 **`redeem-service.ts`**。
   - `packages/application/src/index.ts` 保持同名导出，对外部消费者完全向后兼容。
2. **硬件驱动统一**：
   - 删除 `packages/runtime/src/hinata-io-executor.ts` 与 `packages/platform/src/hinata.ts` 的重复实现，统一收录至 `packages/server/src/hardware/hinata.ts`，保留完整 E2EE 加密驱动。
   - 删除 `packages/runtime/src/ttlock-executor.ts` 与 `home-assistant-executor.ts`，统一收录至 `packages/server/src/hardware/`。
3. **迁移脚本与切面命名规整**：
   - 原 `platform/src/location-time-zone.ts` 在移入 server 时命名为 `shop-time-zone-migration.ts`，不再与 `core/location-time-zone.ts` 冲突。
   - 原 `server-hono/src/api-time.ts` 在移入 server 时命名为 `response-time-projection.ts`。

---

## 7. 文档同步要求（Documentation Synchronization）

遵循 `AGENTS.md` 强制规则，重构完成后同步更新下列文档：
1. `AGENTS.md`：更新模块组织描述（移除 `server-hono`, `runtime`, `platform`，加入 `server`）。
2. `docs/platform-merge.md`：记录此次架构真正统一的落地成果。
3. `docs/architecture.md`：更新最新的后端分层与请求生命周期时序图。
4. `docs/deployment.md`：更新命令与环境变量说明。
5. `packages/server/src/legacy/README.md`：提供详尽的旧版 API 清单与迁移指引。

---

## 8. 验证计划与验收标准

1. **静态检查**：`bun run typecheck` 零类型报错，项目间 TypeScript Project References 正确关联。
2. **单元测试与回归**：`bun test` 全量通过（特别是 billing, cashier, live-activity, settlement, passkeys, auth 等核心测试）。
3. **平台构建校验**：`bun run check:server`（前端 build + wrangler deploy --dry-run）完全成功。
4. **功能兼容验证**：
   - 多租户 API 路径（`/api/v1/shops/:shopCode/...`）运行正常且不再经过二次 request 转发。
   - 旧版单店 API 路径（`/api/v1/player/...`）通过 legacy 适配器正常响应，带有弃用响应头。
