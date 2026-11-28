# PRiSM Launcher (Rust)

Windows 机台无界面原生主机节点客户端（Rust 单文件 EXE，复用了 `hinata-aimeio-rs` 的 WebSocket 鉴权、重连退避、防重放缓存与日志风格）。本地只保存连接地址与独立节点令牌，所有程序列表与默认启动项由 PRiSM 服务端集中配置并在上线时通过 `node.setConfig` 下发。

## 部署步骤

1. 在 PRiSM 后台创建一个 `kind = "launcher"` 的店铺节点（`POST /api/v1/merchant/nodes`），获取一次性令牌和 `wss://域名/node/ws` 地址。
2. 在机台的游戏账号下，将 `launcher.example.json` 复制为与 `prism-launcher.exe` 同目录的 `launcher.json`，填入 `url` 和 `token`。如需将远程文件管理与 PowerShell 工作目录限制在本地特定目录树内，可添加可选字段 `"allowed_roots": ["D:\\Games"]`（服务端下发的 `allowedRoots` 只能进一步收窄、无法放宽本地 `allowed_roots`）。
3. 将 `prism-launcher.exe` 的快捷方式放入该账号的 `shell:startup` 文件夹，配合 Windows 自动登录即可开机无窗口后台运行。游戏与 Launcher 运行在同一权限级别，按键和文本发往当前焦点窗口。
4. 在对应机台资源上绑定该 Launcher 节点（`host` 能力），即可进行程序配置和远端控制；无需机台事先配置 `hinata_io`。

## 远端配置与控制 API

管理员或具有设备管理权限的店长、经理使用商户登录态调用（均经 `DeviceBus` 写入审计日志）：

- `GET /api/v1/merchant/machines/{机台ID}/host`：返回绑定状态、Launcher 在线状态、当前运行程序名、版本号和已保存配置（含可选 `allowedRoots`）。
- `PUT /api/v1/merchant/machines/{机台ID}/host/config`：保存 `{ nodeId, defaultProgram, programs, allowedRoots }`，Launcher 在线时立即推送 `node.setConfig`。
- `POST /api/v1/merchant/machines/{机台ID}/host/commands`：同步下发指令并等待结果：
  - 切换游戏：`{"action":"switch","name":"music"}`
  - 模拟按键：`{"action":"key","key":32,"count":1}`
  - 输入中文/文本：`{"action":"text","text":"玩家一号"}`
  - 全屏截图：`{"action":"screenshot"}`（多屏 GDI 截屏 + 自适应 JPEG 压缩，返回 `{ mime: "image/jpeg", data: "<base64>" }`）
  - 正常重启/关机：`{"action":"reboot"}` / `{"action":"shutdown"}`
  - 文件管理（单文件读写上限 512 KiB，拒绝相对路径、UNC/设备路径、`..` 跳转、符号链接越界与删除根目录）：
    - 列出目录：`{"action":"fs.list","path":"D:\\Games"}`
    - 读取文件：`{"action":"fs.read","path":"D:\\Games\\cfg.ini","encoding":"utf8"}`（支持 `"utf8"` / `"base64"`）
    - 原子写入：`{"action":"fs.write","path":"D:\\Games\\cfg.ini","content":"...","encoding":"utf8","createDirs":false}`
    - 创建目录：`{"action":"fs.mkdir","path":"D:\\Games\\logs","recursive":true}`
    - 重命名/移动：`{"action":"fs.rename","from":"D:\\Games\\a.txt","to":"D:\\Games\\b.txt","overwrite":false}`
    - 删除文件/目录：`{"action":"fs.delete","path":"D:\\Games\\old.txt","recursive":false}`
  - 执行 PowerShell：`{"action":"powershell","script":"Get-Date","cwd":"D:\\Games","timeoutMs":15000,"shell":"powershell"}`（`timeoutMs` 支持 `1000..120000`，`shell` 支持 `"powershell"` / `"pwsh"`，返回 `{ stdout, stderr, exitCode, timedOut, durationMs }`；省略 `cwd` 时同样经安全路径校验器解析，超时自动终止整个 Windows Job Object 进程树）

## 运行特性

- **原生单文件 EXE**：`windows_subsystem = "windows"`，无黑框、无运行时依赖。
- **离线缓存与安全切换**：首次连线拿到 `node.setConfig` 后启动默认程序并缓存至 `%LOCALAPPDATA%\PRiSM Launcher`，后续开机可离线冷启动；切换游戏时先挂起创建新进程并加入新 Windows Job Object，再终止旧 Job 等待进程树退出，最后恢复运行。
- **路径隔离与进程树控制**：所有文件操作与 PowerShell `cwd` 均做规范化及符号链接逃逸校验，本地 `allowed_roots` 优先级高于远端下发配置；PowerShell 通过 `-EncodedCommand` 与受限管道在独立 Windows Job Object 中运行，单流输出上限 64 KiB，超时自动清理整棵子进程树。
- **非阻塞命令执行**：按键、截屏、切游戏、文件操作与 PowerShell 均在后台阻塞线程池执行，不会阻塞 WebSocket 60 秒心跳；入站帧上限提升至 1 MiB 以安全承载 512 KiB 文件上传。
- **令牌失效保护**：收到 `401/403` 停止重连并保持进程存活，避免关闭 Job Object 误杀正在运行的游戏。

## 编译与测试

在本目录执行：

```bash
cargo test
cargo build --release
```

产物位于 `target/release/prism-launcher.exe`。完整节点通信协议见 [`docs/nodes-protocol.md`](../../docs/nodes-protocol.md)。

## 无感自动更新

默认启动后检查更新，每 6 小时复查；店家机台操作页的「检查更新」也可主动检查并下载，返回最新 / 检查中 / 已下载待启动的状态。检查失败展示错误，后台失败只记日志，不影响游戏或连接。旧版 Launcher 不支持该指令，须先手动部署一次支持更新的版本。

`launcher.json` 可配置 `auto_update: false` 关闭定期检查（仍允许店家主动检查），`update_url` 指定 HTTPS 清单地址。默认地址为 `https://github.com/nerimoe/PRiSM/releases/download/launcher-updates/launcher-update.json`。清单包含 `version`（稳定 SemVer）、`url`（HTTPS EXE 地址）、`sha256`（64 位十六进制）、`target`（必须匹配运行架构，当前发布 `x86_64-pc-windows-msvc`）；下载限制 64 MiB，单请求超时 25 秒。SHA-256 校验用于检测文件完整性，发布源须可信。

下载校验成功后将运行中的 EXE 重命名为 `.exe.old`，临时文件改名为原路径；替换失败尝试恢复旧文件。当前进程继续运行，下次开机或维护重启才加载新版，不主动结束游戏、不修改令牌/配置。目录必须允许当前账号写入；替换受杀毒软件/文件锁阻止时保留当前运行版本并报错。备份下次启动清理；不提供新版启动健康检查或自动版本回退。不要在更新完成后运行 `.old` 文件。

发布：修改 `Cargo.toml` 的版本并同步 `Cargo.lock`，推送 main 即可，无需手动创建 tag。`.github/workflows/launcher-release.yml` 在 Launcher / 工作流改动的 PR 和 main 推送时执行 Windows 测试与 x64 构建，并上传 Actions artifact。main 上若 `launcher-v<版本>` Release 尚不存在，自动创建该 tag 和本仓库 Release，附带 `prism-launcher.exe` 与 `launcher-update.json`；版本未变只构建，不重复发布版本。支持手动 workflow_dispatch 重跑。

固定预发布 Release `launcher-updates` 保存稳定版更新清单（指向版本化 Release 的 EXE），每次发布同步更新，不抢占 PRiSM 主产品的 latest。使用本仓库 `GITHUB_TOKEN` 的 contents:write 权限，不需要 HINATA IO 跨仓库发布用的额外令牌；仓库需允许 Actions 写入 Release。PR 仅构建，不发布。
