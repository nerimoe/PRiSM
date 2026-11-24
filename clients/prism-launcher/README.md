# PRiSM Launcher (Rust)

Windows 机台无界面原生主机节点客户端（Rust 单文件 EXE，复用了 `hinata-aimeio-rs` 的 WebSocket 鉴权、重连退避、防重放缓存与日志风格）。本地只保存连接地址与独立节点令牌，所有程序列表与默认启动项由 PRiSM 服务端集中配置并在上线时通过 `node.setConfig` 下发。

## 部署步骤

1. 在 PRiSM 后台创建一个 `kind = "launcher"` 的店铺节点（`POST /api/v1/merchant/nodes`），获取一次性令牌和 `wss://域名/node/ws` 地址。
2. 在机台的游戏账号下，将 `launcher.example.json` 复制为与 `prism-launcher.exe` 同目录的 `launcher.json`，填入 `url` 和 `token`。
3. 将 `prism-launcher.exe` 的快捷方式放入该账号的 `shell:startup` 文件夹，配合 Windows 自动登录即可开机无窗口后台运行。游戏与 Launcher 运行在同一权限级别，按键和文本发往当前焦点窗口。
4. 在对应机台资源上绑定该 Launcher 节点（`host` 能力），即可进行程序配置和远端控制；无需机台事先配置 `hinata_io`。

## 远端配置与控制 API

管理员或具有设备管理权限的店长、经理使用商户登录态调用（均经 `DeviceBus` 写入审计日志）：

- `GET /api/v1/merchant/machines/{机台ID}/host`：返回绑定状态、Launcher 在线状态、当前运行程序名、版本号和已保存配置。
- `PUT /api/v1/merchant/machines/{机台ID}/host/config`：保存 `{ nodeId, defaultProgram, programs, keys }`，Launcher 在线时立即推送 `node.setConfig`。
- `POST /api/v1/merchant/machines/{机台ID}/host/commands`：同步下发指令并等待结果：
  - 切换游戏：`{"action":"switch","name":"music"}`
  - 模拟按键：`{"action":"key","key":32,"count":1}`
  - 输入中文/文本：`{"action":"text","text":"玩家一号"}`
  - 全屏截图：`{"action":"screenshot"}`（多屏 GDI 截屏 + 自适应 JPEG 压缩，返回 `{ mime: "image/jpeg", data: "<base64>" }`）
  - 正常重启/关机：`{"action":"reboot"}` / `{"action":"shutdown"}`

## 运行特性

- **原生单文件 EXE**：`windows_subsystem = "windows"`，无黑框、无运行时依赖。
- **离线缓存与安全切换**：首次连线拿到 `node.setConfig` 后启动默认程序并缓存至 `%LOCALAPPDATA%\PRiSM Launcher`，后续开机可离线冷启动；切换游戏时先挂起创建新进程并加入新 Windows Job Object，再终止旧 Job 等待进程树退出，最后恢复运行。
- **非阻塞命令执行**：按键、截屏、切游戏均在后台阻塞线程池执行，不会阻塞 WebSocket 60 秒心跳。
- **令牌失效保护**：收到 `401/403` 停止重连并保持进程存活，避免关闭 Job Object 误杀正在运行的游戏。

## 编译与测试

在本目录执行：

```bash
cargo test
cargo build --release
```

产物位于 `target/release/prism-launcher.exe`。完整节点通信协议见 [`docs/nodes-protocol.md`](../../docs/nodes-protocol.md)。
