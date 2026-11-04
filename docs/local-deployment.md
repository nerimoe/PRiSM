# 本地部署（备用）

平台平时跑在 Cloudflare（`deploy:beta`）。本地部署是备用方案：同一套代码在一台机器上由 Bun 运行，不依赖任何 Cloudflare 服务。它不从线上迁移数据，启动时是空平台，需要时再通过店铺 JSON 备份导入。

## 运行时如何替代 Cloudflare

请求走的仍是 Worker 的入口 `worker.fetch`，路由、维护模式、静态资源判断和 Worker 完全一致。区别只在 `Env` 里的绑定由谁提供，入口在 `packages/server/src/local/runtime.ts`：

| Cloudflare | 本地 | 位置 |
|---|---|---|
| D1（`env.DB`） | 一个 SQLite 文件（WAL）。`batch` 从 BEGIN 到 COMMIT 同步执行，其它请求不会插进同一个事务 | `local/database.ts` |
| D1 迁移 | 启动前由 `local:upgrade` 执行 `migrations/*.sql`，记账表与 Wrangler 相同（`d1_migrations`）。本地不再有手写表结构 | `local/database.ts` |
| Durable Objects（LiveBilling、ShopHub、MachineRelay） | 同一批类在进程内运行，每个名字一个实例。存储和闹钟放在旁边的 `<库名>.objects.sqlite`，值按结构化克隆存取；闹钟持久化，重启后重新挂上，失败按退避重试 6 次 | `local/object-host.ts` |
| 可休眠 WebSocket（`acceptWebSocket`、标签、附件、自动应答） | 对象返回 101 时，`Bun.serve` 升级原请求并接到对象接受的那一端；连接建立前对象发出的帧会先保存，连上后补发 | `local/websockets.ts` |
| 出站 WebSocket（Home Assistant） | Bun 的 `new WebSocket` | `local/websockets.ts` |
| APNs（只支持 HTTP/2） | `node:http2`，每个源保持一条连接。Bun 的 `fetch` 只走 HTTP/1.1，Apple 会拒绝 | `local/apns.ts` |
| 限流绑定 `RATE_LIMIT_*` | 进程内计数，每个限额一个 60 秒固定窗口。机台登录、设备操作、店铺导入这几条路由没有绑定会拒绝执行，本地会提供 | `local/rate-limit.ts` |
| `ASSETS` | 直接读 `packages/prism-web/dist`：先找文件，再找 `.html` 和目录下的 `index.html`，都没有就返回 `index.html`（单页应用） | `local/assets.ts` |
| 定时任务 `17 * * * *` | 进程内定时器，每小时第 17 分钟执行 | `local/runtime.ts` |

业务代码不区分平台：DO 的调用方通过 `platform/objects.ts` 的 `objectNamespace()` 拿到带类型的命名空间；DO 创建 WebSocket、出站连接 Home Assistant、设置自动应答都通过 `platform/websocket.ts`；APNs 的发送方式由 `useApnsTransport` 决定。这些接口默认是 Cloudflare 的实现，本地运行时启动时换成自己的，停止时换回原来的。

DO 的调用没有排队。Cloudflare 只在对象等待自己的存储时才挡住其它事件，本地存储是同步的，效果相同；对象等待其它 I/O（数据库、Home Assistant、另一个对象）时，其它事件可以穿插执行，两边一样。整段处理加锁会比 Cloudflare 更严格，而且对象 A 调用 B、B 再回调 A 时会死锁。

## 使用

```bash
bun install
bun run local:upgrade      # 首次建库；之后每次更新代码后执行（服务需停止）
bun run local:start        # 构建前端并启动，默认端口 8787
```

- 数据库默认是 `./data/prism.sqlite`（已被 git 忽略），用 `PRISM_SQLITE_PATH` 修改；DO 存储在同目录的 `prism.objects.sqlite`。
- 端口和监听地址分别用 `PORT`、`HOST` 设置。
- Worker 的变量和密钥从环境变量读取（可放在 `.env`）：`APP_ORIGIN`（对外的 https 地址）、`SESSION_SECRET`、`URL_ENCRYPTION_KEY`、`MUNET_CLIENT_ID`、`MUNET_CLIENT_SECRET`、`APPLE_TEAM_ID`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_PRIVATE_KEY`、`EXTRA_ALLOWED_ORIGINS`、`ANDROID_CERT_FINGERPRINTS`、`PRISM_BOOTSTRAP_TOKEN_HASH`。`SESSION_SECRET` 和 `URL_ENCRYPTION_KEY` 要和加密数据时用的一致，否则已加密的卡号、设备密钥读不出来。
- 版本号取 `PRISM_DEPLOY_REVISION`，没有设置时用当前 git 提交，`/health` 的 `x-prism-revision` 响应头会带上它。
- 前面放 Caddy 或 Nginx 终止 TLS；机台用 `wss://<域名>/io/ws`，反向代理要转发 WebSocket 升级。

## 升级、备份、恢复

本地没有 `deploy:beta` 那样的维护阶段：升级时服务是停着的，所以不需要写入屏障。

- `local:upgrade`：先把数据库和 DO 存储备份到 `data/backups/`（`VACUUM INTO`），再执行未应用的迁移和数据转换（UTC 计价、导入版本时区、店铺时区，与 `deploy:beta` 的 convert 步骤是同一套函数），最后检查转换标记、计价全部为 UTC、外键完整。任何一步失败都不会启动服务，用备份恢复即可。
- `local:start`：迁移没有全部应用时拒绝启动，提示先执行 `local:upgrade`。
- `local:backup [目录]`：服务运行中也可以执行，得到一致的副本。
- `local:restore <备份.sqlite>`：放回备份（同时放回对应的 objects 备份）。
- 服务运行时会写 `<库名>.pid`；它还活着时 `local:upgrade` 和 `local:restore` 都会拒绝执行。

由旧版 `dev:local` 手写表结构创建的数据库没有迁移记账表，`local:upgrade` 会拒绝处理，请用 JSON 备份把数据导入新库。

## 验证记录（2026-11-04）

用本地保存的 prism-neo 导出数据，在全新的本地部署上通过网页完成建店和导入，再检查业务逻辑：

- 建库：49 个迁移全部执行，外键检查通过。
- 导入 `yg-prism-neo-export.json`：17 张业务表的行数与浏览器校验的数量一致（玩家 213、会话 1257、资产流水 2242、设备操作 5974 等），计价已转为 UTC。
- 计费：给导入的玩家按导入的方案计费 2 小时 40 分钟（4 元/30 分钟，宽限 5 分钟），得 6 个单位 24 元；预览、实扣与余额变化一致，账单带完整时间轴。
- ShopHub：看板 WebSocket 经桥接连上真实的 ShopHub，收到快照和监听器帧，`ping` 得到 `pong`。
- MachineRelay：建嵌入式 IO 机台，模拟设备连 `/io/ws` 后在线状态变为 online，员工投币时设备收到 `KEY_PRESS`，断开后变为 offline，错误令牌返回 401。
- APNs：经 `node:http2` 连到 `api.push.apple.com`，未带令牌时返回 403 `MissingProviderToken`，说明 HTTP/2 链路是通的。
- 备份与恢复：运行中备份成功，运行中恢复被拒绝；停止后恢复，备份之后写入的数据消失，`integrity_check` 通过。

另一份 `prism-neo-export.json` 在浏览器转换阶段报「数据损坏」：有礼物引用了找不到的资产定义。这是 prism-neo 转换器对这份数据的问题，与本地运行时无关，Cloudflare 上导入会得到同样的结果。
