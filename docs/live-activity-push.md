# 远端点播实时活动（Remote Live Activity）

## 目标

玩家在 iOS 上已经能看到店铺计费的实时活动（灵动岛 / 锁屏）。这些活动原本是**纯本地**的：由 App 自己 `Activity.request` 创建，只有 App 回到前台轮询时才会更新或结束。

本功能让**任意渠道**发起的入场或结账都能更新那台手机：

- 玩家自己在 App / App Clip 扫码入场；
- 管理员在后台为某个玩家「入场计费」或「结账」；
- 店铺 Bot / 集成接口按 QQ 或卡号发起入场或结账。

关键要求是 **App 不需要在运行**。玩家挂起甚至强杀 App 之后，管理员的一次后台结账仍然要让灵动岛在几秒内变成「本次计费已结束」。

## 为什么用 ActivityKit 直推，而不是静默推送

苹果提供 ActivityKit 的远端更新通道：创建活动时用 `pushType: .token` 拿到一个 **per-activity 推送令牌**，服务端持该令牌直接向 APNs 发送 `apns-push-type: liveactivity` 的 update / end 事件，系统会直接刷新灵动岛。

另一种做法是发静默推送（`content-available`）把 App 唤醒，再由 App 本地更新活动。**这个方案在本场景不可行**：静默推送不会启动被用户强杀的 App，而「App 不在前台」正是本功能要解决的核心场景。因此采用直推。

## 架构

```
[App / App Clip 前台登录]
   Activity.request(pushType: .token)
     → activity.pushTokenUpdates → POST .../player/live-activity/register
     → live_activity_tokens (shop_id, user_id, activity_id, token, bundle_id, session_id)
                                                        ↑ 查令牌
[任意渠道：玩家 / 管理员 / Bot]
   POST /api/v1/shops/{shopCode}/.../session/start | checkout/confirm | sessions/:id/stop
     → billing.ts forward() → server-hono 核心 → sessions.save
     → 响应 2xx → response.clone().json() → 解析 playerId → 反查 user_id
     → executionCtx.waitUntil(pusher.send(...))
                                                        ↓
   APNs (apns-topic = <bundleId>.push-type.liveactivity)
                                                        ↓
                                        灵动岛 / 锁屏实时更新
```

### 埋点为什么在 `packages/platform` 而不是核心域

三个渠道（`/player/*`、`/staff/*`、`/integration/*`）全部经过 `packages/platform/src/billing.ts` 的 `forward()` 进入 `packages/server-hono` 的核心应用。因此：

- 在 `forward()` 外层包一层即可覆盖**所有**渠道，将来新增渠道也不会漏掉；
- APNs 令牌属于**传输层**关注点，`server-hono` / `application` / `core` 核心域不应知道 APNs 的存在，其代码与测试保持零改动；
- 反过来若埋点在 `application/src/player-commands.ts` 与 `settlement.ts` 的 `sessions.save` 处，虽然更集中，但需要给核心域新增端口，侵入性更大。

`live-activity/register` 与 `live-activity/unregister` 两个路由同样**不进入** `forward()`，由 platform 直接处理。

### 玩家身份如何解析

响应体已经携带足够信息，无需按渠道特判：

- 入场返回 `session.playerId`；
- 结账返回 `playerSettlement.playerId`。

Bot 渠道用 `identity` / `identityKey`（QQ、卡号）识别玩家，本身不含账号 id，但**响应里的 `session.playerId` 是全渠道统一的**，再由 `shop_player_accounts(shop_id, player_id)` 反查 `user_id` 即可定位该玩家的设备令牌。这正是让 Bot 渠道无需特殊处理的原因。

## 数据库

`migrations/0025_live_activity_push_tokens.sql` 新增 `live_activity_tokens`：

| 列 | 说明 |
| --- | --- |
| `shop_id` / `user_id` | 定位「哪个账号在哪家店」 |
| `activity_id` | iOS `Activity.id`；App 与 App Clip 是两个 target，同一玩家可能同时存在多个活动 |
| `token` | APNs 实时活动令牌（小写十六进制） |
| `environment` | `sandbox` / `production`，决定 APNs 主机 |
| `bundle_id` | 决定 `apns-topic`（App 与 App Clip bundle id 不同） |
| `session_id` | 该活动当前展示的场次；结账后置 `NULL` |
| `attributes_json` | 创建活动时的 `ActivityAttributes`，回存备查 |

唯一键 `UNIQUE(shop_id, user_id, activity_id)`：App 在令牌轮换后会重复上报，注册接口以 upsert 处理，不会产生重复行。

## 推送内容

`content-state` 的键名必须与 Swift 侧 `StoreVisitAttributes.ContentState` **逐字段一致**（`phase` / `startedAtUnix` / `endedAtUnix` / 可选的 `bill`）。旧版状态没有 bill 时仍可解码。ActivityKit 在无法解码时会静默丢弃推送，测试同时验证字段兼容与 4 KB 大小限制。

- 入场 → `event: "update"`，`phase: "active"`，`startedAtUnix` 取场次真实开始时间；
- 结账 → `event: "end"`，`phase: "ended"`，带 `dismissal-date`（60 秒后消失）。

`startedAtUnix` 是绝对时间戳，落锁屏后由 `Text(timerInterval:)` 在本地渲染，因此跨时区安全。

## 配置

平台入口为 `packages/platform/src/worker.ts`，导出 Hono 应用和 `LiveBilling` Durable Object。`wrangler.platform.jsonc` 声明 `LIVE_BILLING` SQLite namespace 和 `live-billing-v1` 类迁移；生成的部署配置继承它们。上线前计费数据库须已应用 `0028_pricing_versions.sql`。未配置绑定时保留原 start/end 推送行为。

## 金额与倒计时更新

每个店铺／玩家一个 Durable Object，只为已注册实时活动的玩家安排任务。保存玩家标识和修订号，金额与方案始终从真实未结账会话及其锁定版本读取，不修改账单和资产。Alarm 到期后使用现有统一账单预览计算，发送摘要，再安排下一边界；没有全店轮询，也不挂常驻 Future。

`nextTimePricingEvent` 复用计价引擎的优先级、时区、分钟取整、宽限和分段起点，合并多个会话与全局封顶规则的边界。已达到区间或全局封顶的部分不再产生收费倒计时。最近的收费候选点会经统一预览确认；若优惠抵消了金额增长，隐藏该收费倒计时，仍在候选点重新评估后续变化。规则切换与收费同刻时客户端合并标签。

入场、子会话增减、麻将开局／离桌、取消宽限的设备操作、结账和账单预览均触发同步。普通 GET 概览不触发重新计费。短时间事件合并，内容不变不重复推送；批量结账逐玩家同步。新增子会话更新原活动，不另开一份入场活动。回调读取最新状态，修订号变化则放弃旧结果，推送失败通过 Alarm 重试；成功令牌分别记账去重。结账的最终金额读取该会话对应的已保存 checkout，避免混入后一次入场的账单。

本地请求只用于初次创建或恢复已过期内容，也会恢复后台调度。Swift 不复刻计费引擎，倒计时通过系统时间组件持续显示。到下一次检查时间设为 stale；更新尚未到达时隐藏旧倒计时，保留账单金额和时间。全部会话关闭但尚未付款时保留活动，设置 `endedAtUnix` 停止计时并显示“待结账”；成功付款后再结束活动。推送受系统与网络影响，不保证准点到达。无令牌或活动已超过八小时则清理调度状态。

验证：`bun test packages/core/test/live-pricing-event.test.ts packages/platform/test/live-billing.test.ts`，后者在 workerd 中运行真实 Durable Object Alarm，并覆盖 APNs 暂时失败重试、金额去重、结账和令牌清理。

| 变量 | 说明 |
| --- | --- |
| `APNS_KEY_ID` | Apple 开发者后台的 APNs Key ID |
| `APNS_TEAM_ID` | Team ID（本项目为 `XKKMJBTHX5`） |
| `APNS_PRIVATE_KEY` | `.p8` 私钥内容，**必须**用 `wrangler secret put` 注入，不可入库或提交 |

三个变量**全部可选**：任一缺失时推送整体退化为 no-op，因此本地与 beta 环境不需要 Apple 凭据。`APNS_PRIVATE_KEY` 通过 `wrangler secret put APNS_PRIVATE_KEY --config wrangler.generated.jsonc` 设置。

```sh
wrangler secret put APNS_PRIVATE_KEY --config wrangler.generated.jsonc
```

## 可靠性与边界

| 场景 | 行为 |
| --- | --- |
| App 被强杀 | 服务端直接推 APNs，不依赖 App 存活（本功能的核心价值） |
| App 从未为该店创建过活动 | 没有令牌，无法凭空创建活动；记录日志并跳过 |
| APNs 返回 `410 Unregistered` | 活动已消失（被划掉 / App 被删除），删除该行，避免继续推给死令牌 |
| APNs 返回 `429` / `503` | 记为失败并记录日志，不影响计费 |
| 结账失败 | 仅在响应 2xx 时推送，失败绝不发送 `end` |
| 推送耗时 | 用 `executionCtx.waitUntil`，绝不阻塞结账响应；无执行上下文时退化为后台任务 |
| 响应体被埋点消费 | 用 `response.clone()` 读取，保证调用方仍能拿到完整响应体（有单测保护） |
| 跨店 | 令牌按 `shop_id` 查询，B 店操作不会推送到 A 店的活动 |
| 登出 | App 调用 `unregister` 并结束活动，避免残留推送 |
| 用户关闭实时活动权限 | 本地不会创建活动，因而没有令牌，服务端自然跳过 |

## 已知前置条件

1. **`moe.neri.hinatago`、`moe.neri.hinatago.prism` 及两个 widget extension 的 App ID 必须已在 Apple Developer 后台启用 Push Notifications 能力**，且描述文件包含 APNs 权限。这是代码无法绕过的前置条件。
2. 验收需要**真机**：模拟器不支持实时活动推送。
3. App Clip 的实时活动生命周期受系统限制更严（Clip 卸载 / 过期），其令牌更易失效，依赖 `410` 清理路径。

## 测试

`packages/platform/test/live-activity-push.test.ts` 覆盖：

- `content-state` 键名与 Swift `ContentState` 一致（防止静默丢弃回归）；
- ES256 Provider JWT 真实签名并用公钥验签、缓存与轮换；
- APNs 请求头、sandbox / production 主机切换、App 与 App Clip 的 topic；
- 各渠道入场 / 结账路径识别，以及只读接口不触发推送；
- 三种响应体形状下的 `playerId` 与场次提取；
- 令牌注册 upsert、解绑、越权与非法输入拒绝（真实 D1，经 HTTP 路由）；
- **端到端**：真实结账路由触发格式正确的 `end` 推送，且响应体仍可读；
- **结账失败时绝不推送**。

运行：

```sh
bun test packages/platform/test/live-activity-push.test.ts
bun run typecheck
```

## 客户端对应实现

`hinata_go` 侧（均在原生 Swift，无 Dart 桥接）：

- `ios/LiveActivityShared/StoreVisitLiveActivityManager.swift`：`pushType: .token`，监听 `pushTokenUpdates` 上报令牌，结束与登出时解绑；
- `ios/PrismClip/PrismAPI.swift`：`registerLiveActivity` / `unregisterLiveActivity`；
- `ios/PrismClip/MachineLoginViewModel.swift`：登出时调用 `unregisterAllPushTokens()`；结账后经由既有的 `reconcile(session: nil, ...)` 结束活动并解绑。

验证：`sh test/native/run-prism-visit-check.sh`。
