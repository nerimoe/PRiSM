# 端到端：真实 Home Assistant + 真实 IO 固件 + 本地平台

这套脚本不 mock 任何一端：Home Assistant 在 docker 里，平台跑在 `wrangler dev`，HINATA IO 是固件仓库 `hinata-aimeio-rs` 的 `remote.rs` / `ha.rs` 原样编译成 macOS 可执行文件 `io_sim`（`tools/mac-test`），浏览器是 Playwright 的真实 Chromium，App Clip 是 `hinata_go` 里的 `PrismAPI` + `MachineLoginViewModel` 原样编译的 macOS 检查。断言只看真实组件做了什么：看板 WebSocket 收到的帧、D1 里的行、Home Assistant 自己的访问日志里平台读了哪些实体。

`.e2e/` 是本地数据目录（已在 `.gitignore`）。`io_sim` 会真的按投币键，所以**不要**让平台给它发投币。

## 准备（一次）

```sh
# 1. Home Assistant（demo 实体 + 一个只给休息室用的 input_boolean + 访问日志）
mkdir -p .e2e/ha && cp scripts/e2e-ha/ha-config/configuration.yaml .e2e/ha/
docker run -d --name prism-e2e-ha -p 8123:8123 -v "$PWD/.e2e/ha:/config" ghcr.io/home-assistant/home-assistant:stable
bun run scripts/e2e-ha/ha-onboard.ts        # 建管理员、完成引导、发长期令牌 → .e2e/ha.json
# 之后再用：docker start prism-e2e-ha；用完：docker stop prism-e2e-ha（数据留在 .e2e/ha）

# 2. 平台（本地 D1 放在 .e2e/state）
bunx wrangler d1 migrations apply DB --local --persist-to .e2e/state
(cd packages/prism-web && bun run build)    # 平台把前端产物一起服务
bunx wrangler dev --config wrangler.jsonc --ip 127.0.0.1 --port 8787 --persist-to .e2e/state \
  --var APP_ORIGIN:http://127.0.0.1:8787 --var EXTRA_ALLOWED_ORIGINS:http://localhost:8787 \
  --var SESSION_SECRET:e2e-session-secret --var URL_ENCRYPTION_KEY:e2e-url-encryption-key

# 3. 造数据：店主/玩家/平台管理员、店铺和 Bot 令牌、三台设备（走平台自己的接口）、IO 配置 → .e2e/platform.json、.e2e/io/{a,b}.ini
bun run scripts/e2e-ha/seed.ts

# 4. IO 模拟器
(cd ../hinata-aimeio-rs/tools/mac-test && cargo build --bin io_sim)
```

数据里的三台设备：

| 设备 | IO | 电源 | 空调 | HA 令牌 |
| --- | --- | --- | --- | --- |
| 机台A | 直连 | `switch.decorative_lights` | `climate.hvac` | 管理员（平台可创建只读账号 → 能被监听） |
| 机台B | 直连 | `switch.ac` | 无 | 同上 |
| 休息室 | 无 | `input_boolean.lounge_power` | `climate.heatpump` | 非管理员（建不了只读账号 → 永远不被监听） |

## 运行

```sh
bun run scripts/e2e-ha/scenarios.ts [baseline live dedupe handover poweroff lease hadown backfill urls readonly idle bots]   # 平台 ↔ IO ↔ HA，约 8 分钟（lease 要等满 90 秒租约，idle 要等满 1 分钟）
PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-board.cjs            # 商户看板，桌面 + 手机
PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-player.cjs           # 玩家扫码页
PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-watchers.cjs         # 设备页「HA 监听器」区域：店主只读、管理员可改
(cd ../hinata_go && test/native/run-prism-real-check.sh)                                      # App Clip 视图模型
```

每个场景开始前都会杀掉所有 `io_sim`、把 HA 实体重置成已知值、等平台把连接标成非实时。`scripts/e2e-ha/d1.sh "SQL"` 可以随手查本地 D1。

## 覆盖

- `baseline`：没有 IO 时全店非实时，看板的 HTTP 读取来自 HA、每个实体恰好被读一次；看板 WS 先发只带标签的整店快照，随后 Hub 替它问 HA（每个实体一次）把值发来，看板自己不读；非实时设备的变化不推送。
- `live`：IO 上线、首次快照后连接才算实时，快照里休息室只有标签；HA 一变看板几十毫秒内收到推送；实时设备零读取（看 HA 访问日志），只读非实时的休息室；经平台操作实时设备时响应带存储里的读回、不问 HA；操作非实时设备时后端向 HA 读回这一台，响应带上，Hub 推给看板。
- `dedupe`：两个监听器同时在监听，同一变化只写一次事件、只推一条；冻结其中一个（SIGSTOP）另一个仍立刻推送，证明不是「死了才接手」。
- `handover`：断开一个仍实时，全部断开立刻变非实时（几十毫秒，快照只换标签），Hub 随即替看板向 HA 问一次 A、B；非实时后 HTTP 读取回到 HA 直读，重新上线的第一份快照就是当前值。
- `poweroff`：平台给监听器所在机台断电，监听立刻让出（几十毫秒，不等租约）；两个监听器时只断一台的电连接仍实时。
- `lease`：进程冻结、连接不断，90 秒租约到期后变非实时，恢复后 hub 重新下发监听并重新实时。
- `hadown`：HA 重启，看板几秒内变非实时，HA 不可用时读取不报错不卡住（返回 null，看板显示未知），HA 回来后重新实时且快照与 HA 一致。
- `urls`：把连接的内部地址设成不可达（192.0.2.1），IO 上线约 10 秒（一个连接超时）后用第二个地址变成实时；HA 重启后 16 秒内重新实时。没有连接超时时是 75 秒，且每一轮重连都要再等一次。
- `readonly`：平台自动建的只读令牌能读实体、调用开关和空调服务被 Home Assistant 拒绝且状态不变，店家给的控制令牌仍然有效。
- `backfill`：把一条连接改成功能上线之前存下的样子（没有只读令牌、`readAccess` 为空），IO 一上线平台就在真实 HA 里补建账号并变成实时（约 1 秒）；旧令牌失效（换掉而不是叠加），`needs_admin` 的连接不会被反复尝试。
- `idle`：「店里没人 1 分钟后关机」生效后，五个电源和空调实体全部被关掉，包括没有任何存储状态的休息室；被关掉的机台 IO 立刻让出监听。
- `bots`：用插件真实代码跑的 Bot（`bot-sim.ts`）当监听器：Bot 上线顶掉机台、两个 Bot 占满、让位期间看板没有听到一次「不再实时」、Bot 和机台同时监听同一个变化只推一次、Bot 掉线机台补位、店主改数量 403 / 管理员改成功、数量 1 / 4 / 回 2 各自的结果、越界 422、只有一个 Bot 没有机台时连接也能实时。
- 浏览器：看板只显示后端发来的（标签只是显示）、进入页面不发 HTTP 读取、刷新按钮一次整店读取由后端决定问谁、面板操作靠响应的读回、IO 掉线后 Hub 替看板问 HA；玩家页 hub 的招呼不等 HA、值随后由 hub 补发、页面不读 `/session/device`、开机以后端读回为准、调温 1 秒防抖、IO 掉线后 hub 替页面问一次 HA、回来后不再读。
- App Clip：同样的玩家页行为，经真实 `URLSessionWebSocketTask`。

## 注意

- 从头来过时：停掉 wrangler，删除 `.e2e/state/v3/do/prism-platform-ShopHub`，并清空 `ha_event_connections`（`scripts/e2e-ha/d1.sh "DELETE FROM ha_event_connections"`）。Hub 是这张表的唯一写入者，只清其中一边会留下与 Hub 不一致的「实时」记录。
- 访问日志靠 `aiohttp.access` 打开；平台读 HA 的请求没有 User-Agent，脚本据此把平台和测试脚本自己的读取区分开（脚本自己用 Bun / Node / curl，User-Agent 不同）。
