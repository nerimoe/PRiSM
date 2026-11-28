# 边缘节点接入与通信协议（HINATA IO / PRiSM Launcher / IoT 控制器）

PRiSM 将所有直连现场软硬件统一抽象为**店铺级边缘节点（`shop_nodes`）**，遵循「哑终端 + 服务端单一真相源」原则，且协议与具体硬件芯片解耦（`iot` 节点可用 ESP32、树莓派、RP2040 等任意实现该协议的硬件，芯片型号仅通过 `node.hello` 的 `model` 字段上报展示）：

- **节点本地只保存连接地址与独立节点令牌**（`Authorization: Bearer <token>`），不需要在客户端或固件里手写机台映射、引脚列表、BLE 信标编号或 Home Assistant 凭据。
- **服务端按节点类型（`kind`）区分线协议适配器**（`packages/server/src/hardware/node-protocol.ts`）：
  - `hinata_io`：沿用既有动作/JSON-RPC 混合协议，保证现场已部署 IO 无需升级。
  - `launcher` 与 `iot`：统一使用纯 **JSON-RPC 2.0**，由服务端通过 `node.setConfig` 实时下发推导出的全部运行时配置。
- **业务能力与节点解耦**：机台资源在 `device_capabilities` 中通过 `nodeId` 绑定节点（支持 1:0、1:1、1:N），所有控制命令经 `DeviceBus`（`packages/server/src/resources/capabilities/runtime.ts`）执行并留痕。

---

## 1. WebSocket 入口与鉴权

| 路径 | 用途 |
| --- | --- |
| `wss://<域名>/node/ws` | 所有边缘节点的统一入口（推荐用于 Launcher、IoT 控制器及新部署 IO） |
| `wss://<域名>/io/ws` | 等价兼容别名，保留给既有 HINATA IO 客户端 |

- 握手请求必须带 `Upgrade: websocket` 和 `Authorization: Bearer <node-token>`。
- URL 不携带 `shopId`、`nodeId` 或 `role`；网关（`packages/server/src/gateway/machine-relay-gateway.ts`）通过 token 的 SHA-256 哈希查询 `shop_nodes`（并兼容尚未迁移的旧 `hinata_io` 能力行），权威解析出 `(shopId, nodeId, kind, channel)` 后转发至该节点专属的 `MachineRelay` Durable Object。
- **返回 `401` / `403`**：表示令牌无效或节点已停用，客户端应停止重连并等待管理员更新令牌（Launcher 保持游戏进程不退出）。
- **返回 `5xx` 或网络断开**：指数退避重连（建议 2s → 上限 60s）。
- `wrangler.jsonc` 的 `assets.run_worker_first` 需同时包含 `/io/*` 与 `/node/*`。

---

## 2. 商户端管理 API

挂在 `/api/v1/merchant` 下（需要 `admin` 或该店设备管理权限）：

### 节点管理（`packages/server/src/routes/platform/merchant-nodes.ts`）
- `GET /nodes?shopId=<id>&kind=<hinata_io|launcher|iot>`：列出店铺节点、实时在线态、版本/型号、当前运行程序及各资源绑定关系（含 IoT 节点已占用 GPIO 引脚）。
- `POST /nodes` / `PATCH /nodes/:id` / `DELETE /nodes/:id?shopId=<id>`：底层节点管理接口（支持脚本/自动化调用；日常商家后台直接在资源编辑页管理，无需单独硬件中心）。
- `GET /beacons?shopId=<id>`：返回店铺启用中的 BLE 信标池（`{ nodeId, nodeName, resourceId, beaconId, txPower, rssiThreshold }`）。

### 资源能力与管理接口（`packages/server/src/routes/platform/merchant-resources.ts`）
所有设备统一通过「资源 + 能力」管理，不再设独立硬件节点中心：
- `POST/PATCH /machines` 支持：
  - `hinata_io`：直连模式自动维护 `io_<machineId>` 节点，提供读卡与卡簿上报。
  - `host`（启动器）：自动维护 `ln_<machineId>` 节点（`rotateHostToken: true` 一次性签发/轮换令牌与 `launcher.json`），管理可切换游戏/程序列表与默认启动项，保存后即时推送 `node.setConfig`。
  - `iot`（IoT 控制器）：自动维护 `iot_<machineId>` 节点（`rotateIotToken: true` 一次性签发/轮换令牌），自动分配 `beaconId` 并始终启用蓝牙近场信标广播与常驻 Home Assistant 监听（不对店铺暴露开关）。移除 `iot` 能力或删除该资源时若仍有其它资源引用其 GPIO 或蓝牙信标，返回 `409 NODE_IN_USE`。
  - `keys`（机台按键）：统一配置最多 16 个按键，每个按键支持二选一：
    - `mode: "keyboard"`：Windows 键盘 VK 码，执行时**优先走 PRiSM Launcher，离线或未配置时自动回落 HINATA IO**。
    - `mode: "gpio"`：指向本资源或店内任意带 `iot` 能力资源的 GPIO 输出引脚（`0..255`）、脉宽与电平极性，保存时校验跨全店引脚冲突并自动推送至对应控制器。
  - `coin`（投币，依赖 `keys`）：指定 `keys` 中的一个按钮作为投币触发，配置直连 IO 的投币上限与刷卡后自动投币；仅当选中的投币按钮为 `gpio` 模式时支持挂接可选的 GPIO 硬件回报输入（`feedbackNodeId`、`feedbackPin`、`feedbackEdge`、`feedbackDebounceMs`、`feedbackSignal`）。
  - `locationOverride`（位置校验覆盖）：可选 `inherit`（跟随店铺）、`require`（强制校验，可选限定特定 IoT 控制器及近/标准/远感应距离覆盖；旧版 `ble` / `gps` 读取时自动归一化为 `require`）或 `none`（不校验位置）。定位方式按「资源限定在线信标 → 全店在线信标池 → 店铺 GPS 围栏」自动选择，无在线信标时自动回退 GPS。
  - **能力冲突、依赖与二维码链接规则**：`bot` 与所有其它能力冲突；`iot` 与 `table`/`door`/`climate` 冲突；`coin` 依赖 `keys`。`bot` 与 `iot` 声明无需玩家链接——纯 `bot` 或纯 `iot` 资源自动无二维码且不可被玩家扫码，而挂了任意玩家侧能力（例如 `iot + keys + coin`）或无能力的资源保有二维码。
- 店铺级位置校验（`GET/PUT /api/v1/shops/:code/settings`）：入场（`checkinGeo`）、离场（`checkoutGeo`）与资源操作默认（`machineGeo`）独立开关，搭配默认蓝牙感应距离（`locationRssiThreshold`：近 `-65` / 标准 `-75` / 远 `-85` dBm）；IoT 节点在线状态写入 `device_state`（`capability='iot', key='link'`），`GET /api/v1/merchant/beacons` 返回每个信标的 `online` 状态，信标上下线自动刷新玩家页。
- 主机快捷接口（命令经 `DeviceBus` 审计）：
  - `GET /machines/:id/host`
  - `PUT /machines/:id/host/config`
  - `POST /machines/:id/host/commands`

### 商户网页端入口（`packages/prism-web/src/ui/merchant/`）
- **统一资源页（`Resources.tsx` & `ResourceEditor.tsx`）**：所有设备平铺为资源，无独立硬件中心。
  - 「基本信息」包含「位置校验」（跟随店铺并显示当前继承状态 / 强制校验位置，可选限定特定 IoT 控制器与近/标准/远感应距离覆盖 / 不校验位置）。
  - 「添加能力」自动标出冲突项并禁用，添加「投币」时自动一并启用「机台按键」。
  - `HINATA IO`、`启动器` 与 `IoT 控制器` 均在对应能力面板内联签发/轮换令牌，一次性展示配置片段；`IoT 控制器` 面板不暴露 HA 监听/蓝牙信标开关与底层射频参数，仅展示连接状态、自动分配的信标编号与全店 GPIO 引脚占用清单。
- **操作面板（`Resources.tsx` & `HostControls.tsx`）**：提供独立的「机台按键」分组（同时支持键盘与 GPIO 按键）与「启动器」分组（切游戏、临时按键、中文文字输入、实时截屏、二次确认重启/关机、受控文件管理与 PowerShell 终端）；`HaWatchers.tsx` 同步显示 IoT 控制器监听器。
- **独立「设置 → 位置校验」（`LocationSettings.tsx`）**：聚合展示当前生效定位方式（在线蓝牙信标优先 / 无在线信标自动回退 GPS）、入场/离场/资源操作三个独立开关、蓝牙信标池在线状态与默认感应距离、GPS 地图与围栏半径（不展示时区）、以及已单独覆盖定位的资源列表（支持一键恢复跟随店铺）。

---

## 3. 统一 JSON-RPC 2.0 协议（PRiSM Launcher & IoT 控制器）

### 3.1 连接握手与心跳（节点 → 平台）

连上后立即发送一次 `node.hello`（被动元信息，不需要回报能力列表；`model` 可填任意硬件型号如 `esp32-s3`、`rpi-zero-2w`、`windows-x64`）：

```json
{
  "jsonrpc": "2.0",
  "method": "node.hello",
  "params": {
    "version": "1.0.0",
    "model": "esp32-s3"
  }
}
```

每 **60 秒**发送一次 `node.heartbeat`（平台收到任何入站消息均刷新活性，超过 **150 秒**无消息判定离线）：

```json
{
  "jsonrpc": "2.0",
  "method": "node.heartbeat",
  "params": {
    "program": "music",
    "uptime_s": 3600,
    "ha": [
      { "term": 4, "connection": "ha_1", "connected": true, "error": null }
    ]
  }
}
```

- `program`：Launcher 填写当前运行程序名（无则为 `null`）。
- `ha`：IoT 节点参与 Home Assistant 监听时上报各 HA 连接健康状态；无当前任务时发空数组 `[]`，服务端会按需重新分配。

### 3.2 配置推送（平台 → 节点）

节点上线后以及后台配置变化时，服务端推送 `node.setConfig`（通知，无 `id`）。节点可持久化到本地缓存/NVS 用于断网冷启动。

**Launcher 收到的 `params`：**
```json
{
  "default": "music",
  "programs": [
    { "name": "music", "path": "D:\\Games\\Music\\start.cmd" }
  ],
  "allowedRoots": ["D:\\Games"]
}
```
注：`allowedRoots` 仅在服务端配置了目录白名单时下发；Launcher 本地 `launcher.json` 中的 `allowed_roots` 不可被远端配置放宽（两者同时配置时取交集）。

**IoT 节点收到的 `params`：**
```json
{
  "ble": {
    "enabled": true,
    "beaconId": 42,
    "txPower": -59
  },
  "gpio": {
    "outputs": [
      { "pin": 12, "activeLow": true, "defaultPulseMs": 80 }
    ],
    "inputs": [
      { "pin": 13, "pull": "up", "edge": "falling", "debounceMs": 50 }
    ]
  }
}
```

### 3.3 同步命令与回复（平台 ↔ 节点）

平台下发带唯一 `id` 和毫秒时间戳 `expires_at`（常规命令默认 30s TTL / 35s DO 超时；文件读写 40s TTL / 45s DO 超时；PowerShell 按请求 `timeoutMs + 10s` 动态缩放 TTL 与 DO 超时，上限 150s；单帧严格限制在 1 MB 以内）的 JSON-RPC 请求；节点校验防重放与未过期后执行并回复：

| 节点类型 | `method` | `params` | `result` |
| --- | --- | --- | --- |
| Launcher | `host.switch` | `{ "name": "music", "expires_at": ... }` | `{}` |
| Launcher | `key.press` | `{ "key": 32, "count": 1, "expires_at": ... }` | `{}` |
| Launcher | `host.text` | `{ "text": "玩家一号", "expires_at": ... }` | `{}` |
| Launcher | `host.screenshot` | `{ "expires_at": ... }` | `{ "mime": "image/jpeg", "data": "<base64>" }` |
| Launcher | `host.reboot` / `host.shutdown` | `{ "expires_at": ... }` | `{}` |
| Launcher | `host.fs.list` | `{ "path": "D:\\Games", "expires_at": ... }` | `{ "path": "...", "entries": [...], "truncated": false }` |
| Launcher | `host.fs.read` | `{ "path": "...", "encoding": "utf8" \| "base64", "expires_at": ... }` | `{ "path": "...", "encoding": "...", "content": "...", "size": 123 }` |
| Launcher | `host.fs.write` | `{ "path": "...", "content": "...", "encoding": "utf8" \| "base64", "createDirs": false, "expires_at": ... }` | `{ "path": "...", "bytesWritten": 123 }` |
| Launcher | `host.fs.mkdir` | `{ "path": "...", "recursive": true, "expires_at": ... }` | `{ "path": "...", "created": true }` |
| Launcher | `host.fs.rename` | `{ "from": "...", "to": "...", "overwrite": false, "expires_at": ... }` | `{ "from": "...", "to": "..." }` |
| Launcher | `host.fs.delete` | `{ "path": "...", "recursive": false, "expires_at": ... }` | `{ "path": "...", "deleted": true }` |
| Launcher | `host.powershell` | `{ "script": "...", "cwd"?: "...", "timeoutMs": 15000, "shell": "powershell" \| "pwsh", "expires_at": ... }` | `{ "stdout": "...", "stderr": "...", "exitCode": 0, "timedOut": false, "durationMs": 42 }` |
| IoT | `gpio.pulse` | `{ "pin": 12, "duration_ms": 80, "count": 1, "active_low": true, "expires_at": ... }` | `{}` |

回复格式：
```json
{ "jsonrpc": "2.0", "id": "<req-id>", "result": {} }
```
或失败时：
```json
{ "jsonrpc": "2.0", "id": "<req-id>", "error": { "code": -32000, "message": "失败原因" } }
```

### 3.4 硬件输入回报（IoT 节点 → 平台）

当配置在 `gpio.inputs` 中的引脚触发（经本地防抖）时上报：

```json
{
  "jsonrpc": "2.0",
  "method": "event.gpio",
  "params": {
    "pin": 13,
    "edge": "falling",
    "count": 1
  }
}
```

服务端按 `(nodeId, pin)` 查表定位绑定的机台资源，转换为标准信号（`cabinet.coin` / `cabinet.consumed` / `cabinet.activity`）写入 `DeviceBus`，自动驱动占用、防闲置与事件记录。

### 3.5 Home Assistant 监听（平台 ↔ IoT 节点 / HINATA IO）

- `ShopHub` 监听器候选池优先级：**独立 IoT 节点（常电硬件） > Koishi Bot > 稳定 HINATA IO > 普通 HINATA IO**。
- 平台下发给 IoT 节点：
  - 开始/更新监听：`{ "jsonrpc": "2.0", "method": "ha.watch", "params": { "term": 4, "connections": [{ "id": "ha_1", "urls": ["http://ha.local:8123"], "token": "...", "entities": ["switch.a"] }] } }`
  - 停止监听：`{ "jsonrpc": "2.0", "method": "ha.unwatch", "params": {} }`
- IoT 节点上报状态变化与快照沿用 `ha.states` / `ha.status`（与 HINATA IO 相同结构）。

### Launcher 更新检查

店家主机命令 `{"action":"update.check"}` 经 DeviceBus 权限校验和审计，转成 `host.update.check`（沿用指令有效期/防重放；等待上限 95 秒）。节点后台下载，返回 `status: current | checking | pending`，pending 带 `version`；错误走普通 RPC 错误。自动检查默认每 6 小时一次，新版下次启动生效，不重启当前游戏。部署与发布清单见 `clients/prism-launcher/README.md`。

### Launcher 游戏守护

Launcher 本地每秒检查最后成功启动的游戏 Job Object；全部进程退出后延迟拉起，连续退出采用 2–60 秒退避，稳定运行 60 秒后重置。离线仍守护，主动切换后守护新程序，被配置移除的程序不再拉起。仅处理进程树退出（含正常关闭），不检测卡死，具体行为见 Launcher README。
