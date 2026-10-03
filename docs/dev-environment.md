# 当前工作区开发环境

主仓库位于 `/workspace/PRiSM`，基准提交为 `4400b2b`。已初始化 Git 跟踪的 Dashboard 和 Koishi 子模块，按 `bun.lock` 安装全部 Bun workspace 依赖，并安装 Flutter 管理端及 Koishi 子模块自身的依赖。

| 工具 | 版本 | 路径 |
| --- | --- | --- |
| Bun | 1.4.2 | `/home/agent/.bun/bin/bun` |
| Flutter | 3.47.6 stable | `/workspace/flutter/bin/flutter` |
| Dart | 3.13.5 | `/workspace/flutter/bin/dart` |

工具路径已写入用户 shell 配置。项目管理端要求 Dart `^3.12.0`；当前 SDK 满足要求。Flutter 首次获取依赖会按 SDK 更新测试工具的依赖解析，本地安装产物位于子模块 `.dart_tool` 中。

Flutter 自动改写的分析配置和依赖锁文件已恢复为子模块原始内容，现已按 [UTC 时间约定](utc-time-contract.md) 修改管理端业务代码；本地已解析的依赖可用于上述 `--no-pub` 检查及运行。

## 启动和检查

```bash
cd /workspace/PRiSM
source ~/.profile
bun run dev:all
```

本地 `.env` 将 SQLite 放在 `data/dev.sqlite`，后端端口为 8787，Dashboard 静态端口为 5500。SQLite 首次启动自动创建 schema。数据库与 `.env` 已被仓库忽略。

- 后端健康检查：`http://localhost:8787/health`
- 管理端：`http://localhost:5500`，连接本地后端 `http://localhost:8787`，通过安装向导创建开发账户。
- `http://localhost:8787/admin` 仅提供管理端部署提示，并不直接托管 Flutter 页面。

修改 Flutter 后，可用以下命令启动开发服务器，先停止占用 5500 的静态服务器：

```bash
cd /workspace/PRiSM/packages/prism-dashboard
flutter run -d web-server --web-port 5500 --web-hostname 127.0.0.1 --no-pub
```

构建与校验：

```bash
bun run typecheck
bun test --timeout 30000
bun run build:web
bun run prism-dashboard:analyze
bun run prism-dashboard:test
bun run prism-dashboard:build
bun run scripts/reproduce-billing-gaps.ts
```

已使用 `bun run scripts/generate-wrangler-config.ts --local --platform` 生成被 Git 忽略的本地 Worker 配置，使用官方脚本的本地占位 ID，不包含真实 Cloudflare 凭据。没有创建远程数据库或部署。

默认 5 秒测试超时在首次启动 Miniflare 或与 Flutter 首次编译同时进行时不足，会导致平台测试超时及后续连带失败。使用 30 秒超时复核。计费空白时段的具体分析和复现结果见 [billing-gap-analysis.md](billing-gap-analysis.md)。

修改前首次编译结束后执行 `bun test --timeout 30000`，全量 602 项测试通过（0 失败，58.26 秒）。已验证 TypeScript 类型检查、React 网页构建、Flutter 静态分析、133 项 Flutter 测试及 Flutter Web 构建。Koishi 子模块类型检查、构建及 49 项测试通过。计费相关的 54 项测试通过，内存 SQLite 复现脚本验证了非营业入场拒绝、跨夜收费、规则日时间轴和实际钱包扣款。

本地服务已用 `dev:all` 启动，后端健康检查、安装状态接口、Dashboard HTML 及主 JavaScript 文件均返回 HTTP 200；初始安装状态为未安装，可直接开始向导。没有启动独立 AstrBot 实例；它不属于当前跟踪的两个子模块。

## UTC 修复后的验证

本次 UTC 修改后，TypeScript 类型检查通过，全量 Bun 测试 612 项、Flutter 测试 138 项通过；Flutter 静态分析、React 和 Flutter Web 构建均通过。两个内存 SQLite 脚本分别验证截图场景、非营业空档及实际钱包扣款；迁移测试验证 0029 SQL 与 SQLite schema 一致、重复启动幂等、旧会话绑定不变、切换 UI 时区不发布。使用 `TZ=America/New_York` 单独验证 UTC 规则和 UI 时间戳转换不依赖服务器系统时区。

修改包含 `prism-dashboard` 子模块的代码与测试。提交时需在子模块提交其修改，再更新主仓库 gitlink；当前工作区已保留全部修改。D1 升级需应用 `migrations/0029_utc_pricing.sql`；本地 SQLite 在启动时自动加载更新的 schema。

## 历史 UTC 迁移验证

已加入事务数据迁移 `utc-pricing-data-v1`：当前方案、历史版本和账单时间解释等价转换，历史金额、会话绑定、累计身份及已支付额度保留。本地开发库（尚无历史业务数据）已执行；第二次执行返回 `applied: false`。有历史数据的 SQLite 与真实 Miniflare D1 测试验证了不同发布时区共享版本、夏令时 23／25 小时窗口、重复执行、并发只提交一次、失败整批回滚、当前玩家重新入场的累计衔接和固定收费身份保留。

本轮类型检查和 619 项全量 Bun 测试通过，React 构建和两份内存业务复现脚本通过。Dashboard 本轮没有追加修改，沿用上一轮已通过的 138 项测试及构建。新版 SQLite、Worker 及后台活动账单读取会在业务运行前完成一次数据迁移；单独执行本地迁移可用 `bun run scripts/migrate-pricing-utc.ts data/dev.sqlite`。

统一平台的展示时区现随店铺 WGS84 位置自动识别，地图选点、GPS 和手动经纬度输入都会更新；浏览器自身时区不参与识别。位置保存后服务端独立计算并原子保存展示时区。已有店铺在完成 UTC 业务迁移后，首次请求通过 `shop-location-time-zone-v1` 标记补齐，重复执行不改动数据。独立旧版 runtime 无位置表，保留其展示设置。

位置时区改动后的 626 项全量 Bun 测试、类型检查、React 构建和 Worker dry-run 打包通过。新增真实 D1 验证已有店铺补齐、整批回滚和幂等；接口验证跨地区移动自动变更时区、位置与时区一起回滚、忽略手动时区覆盖及 UTC 规则／发布不变。地理查询覆盖上海、东京、纽约、伦敦、加德满都和阿拉木图，并在服务器 `TZ=America/New_York` 下复测，不依赖服务器系统时区。本轮未部署线上。
