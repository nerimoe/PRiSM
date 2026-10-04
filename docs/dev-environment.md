# 开发环境

管理与玩家前端统一位于 `packages/prism-web`，采用 React + Vite，后端由 `packages/platform` 的统一 Worker 提供。开发和发布均不再依赖 Flutter 后台或 Flutter SDK。

当前工作区位于 `/workspace/PRiSM`，已安装 Bun 1.4.2。Koishi 和 AstrBot 子模块是可选机器人集成，不影响 React 后台开发。

## 启动

```bash
bun install
bun run dev:all
```

`dev:all` 构建 React 静态资源、生成被 Git 忽略的本地平台配置、应用本地 D1 迁移，然后启动 Wrangler API 和 Vite。平台开发数据库位于 `.wrangler`，不使用独立 runtime 的 `PRISM_SQLITE_PATH`。

- API 健康检查：`http://127.0.0.1:8787/api/v1/health`。
- 店铺后台：`http://localhost:5173/merchant`。
- 玩家页面：`http://localhost:5173/t/:shopCode`。

可通过 `PORT` 和 `WEB_PORT` 分别修改 API 和前端端口，代理与允许来源同步调整。平台登录需配置真实 OAuth 凭据；本地配置和数据库不提交到 Git。可用 `ASTRBOT_DIR` 指定可选 AstrBot 目录；Ctrl+C 或 SIGTERM 会停止开发进程。

`bun run dev:local` 保留独立 SQLite 兼容 API，用于旧接口调试和回归。它不提供统一平台的 React API；其 `/admin` 页面提示启动 React 开发环境。

## 检查与发布

```bash
bun test --timeout 30000
bun run typecheck
bun run check:platform
```

平台测试涉及 Miniflare，首次启动使用 30 秒测试超时。`check:platform` 构建 React 并进行 Worker dry-run，不部署线上。

版本号统一使用根 `package.json` 的 SemVer。`bun run version:bump patch` 不再依赖其他前端仓库。`bun run deploy:beta` 构建 React、生成平台配置、应用远程 D1 迁移并发布 Worker，需预先配置 Cloudflare 与平台登录凭据。

## UTC 与位置时区

业务统一使用 UTC；React 编辑和展示按店铺位置对应的 IANA 时区转换。地图选点、GPS 和手动经纬度输入都会更新只读时区提示，服务端独立计算并原子保存位置与时区，浏览器自身时区不参与识别。

事务迁移 `utc-pricing-data-v1` 等价转换当前规则、历史版本及账单的时间解释，保留金额和会话绑定。已有店铺通过 `shop-location-time-zone-v1` 补齐位置时区；两个迁移均有一次性标记，重复执行不会再次偏移，失败整批回滚。独立 SQLite 迁移可用 `bun run scripts/migrate-pricing-utc.ts data/dev.sqlite`。

相关说明见 [UTC 时间约定](utc-time-contract.md)、[计费空白时段分析](billing-gap-analysis.md) 和 [部署指南](deployment.md)。

移除旧后台后，627 项 Bun 测试、TypeScript 检查、React 构建和 Worker dry-run 打包通过。实际以 `PORT=8792 WEB_PORT=5175` 启动 `dev:all`，后台、玩家页面和 API 代理均返回 HTTP 200；退出后两个端口均释放。未执行线上部署。

多平台身份升级需应用 `0030_platform_identity_bindings.sql`，`dev:all` 会应用本地迁移。Bot 需使用此版 Koishi 源码／构建包；平台标识不再手填，由消息适配器提供。迁移保留旧身份，店主在设置中主动预览和执行转换。

本轮主仓库 635 项 Bun 测试和 Koishi 插件 51 项测试通过；两个仓库类型检查、React／Worker 和 Koishi 构建通过。本地 `dev:all` 已应用 0030，绑定表及所有权触发器可用，React 与 API 代理返回 HTTP 200。身份转换测试覆盖冲突、过期预览、整批回滚、相同玩家去重及操作重放；已在计费时重新开启强制绑定不会阻止结账。本轮未部署线上，也未发布 npm。

## 商户设置页

React 商户工作台的「设置」按六个分类组织，分类写入 URL 的 `group` 参数，可直接链接与使用浏览器前进／后退。桌面为左侧分类导航，手机为横向导航；分类切换保留当前页面内的输入和新建凭据，离开设置页或刷新不保留未保存草稿。

| 分类 | 内容 |
| --- | --- |
| 基本资料（`general`，默认） | 名称、封面、地图位置、定位范围与随位置自动识别的只读时区 |
| 营业与计费（`billing`） | 转换为计费店铺、入场计费、前台收银、选择入场规则与计费管理入口 |
| 玩家与身份（`players`） | 强制平台身份绑定、自动注册、新玩家礼物；折叠的身份转换工具 |
| 位置与设备（`devices`） | 位置校验、投币冷却、折叠的 TTLock 账号连接 |
| Bot 与接入（`integrations`） | Koishi 店铺编号／API 地址与 Bot、机台凭据管理 |
| 成员与权限（`members`） | 店铺成员与操作权限 |

各表单有独立保存入口。保存前读取最新配置，仅合并当前表单负责的字段，防止保存一个分类时连带提交其他分类的未保存修改。设置页仍只对店铺 owner 开放；业务时间和计费规则的 UTC 约定不变，平台身份转换不会自动执行。

设置页重组验证：635 项 Bun 测试、TypeScript 检查、React 构建与 Worker dry-run 通过。本地浏览器检查覆盖六组导航、URL／前进后退、独立保存、保留草稿与一次性凭据、390px 手机布局，以及隐藏地图展开和窗口缩放后的居中。

跨客户端时间检查：业务与 SQL 保持 UTC，事件响应输出店铺偏移 ISO 时间。商户／Bot 显示店铺时间，玩家个人时间显示设备时区。Swift 源码克隆于 `/workspace/hinata_go`，Foundation 时间回归可运行 `test/native/run-prism-time-check.sh`；完整 iOS 编译需 macOS／Xcode。详见 [客户端时间约定](client-time-contract.md)。

测试 MuNET 首次注册流程可使用 React 平台管理员「管理 → 删除账号」入口，无需手改数据库。清理范围、重新注册行为与负责人接管规则见 [删除测试账号](admin-account-deletion.md)。
