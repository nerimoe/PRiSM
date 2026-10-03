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
