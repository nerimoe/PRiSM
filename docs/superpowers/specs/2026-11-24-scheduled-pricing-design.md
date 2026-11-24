# 调价计划与修改记录设计

状态：第 1、2 阶段已实现，现行行为以 [价目修改记录与调价计划](../../pricing-changes.md) 为准。实现与本文的差别：

- 不使用 ShopHub 闹钟：开始计费前、读计费规则页时检查到期计划，另有整点 cron 与本地每分钟扫描（§6.3）；
- 计划排着时直接修改，计划没改过的项自动同步进计划，不弹勾选框；改过的项保留计划的值，保存后提示（§6.4）；
- 连续编辑在写入时合并为一条，不在显示时折叠（§7）；
- 记录在修改之后单独写入，不与修改同一批次；失败的改动会合并进下一条（§5）；
- 首次记录前先补一条当前价目的基线；店铺数据导入清空修改记录，导出不包含（§4）；
- 保留 `failed` 状态作兜底；
- 「指定日期」的日期选择器（第三阶段）未做。

## 1. 要解决的问题

现在改计费规则保存即发布（`docs/pricing-versions.md`），日期只能挂在单个时段上。店家想「12 月 1 日起整店换价」时，只能当天零点在线逐条修改，或逐个改资源组、专属资源、麻将桌的规则绑定。同时店里没有任何修改记录：谁在什么时候改了什么价，事后无从查起，改错了也只能凭记忆改回去。

时段上的「生效时间 / 结束时间」（`dateTimeRange`）看似能做定时，其实是 prism-neo 导入的一次性绝对时段，编辑器也不允许新建，反而让人以为“时间要在时段上设”。

## 2. 目标与非目标

目标：

- **价目**（全部计费规则 + 全部资源计费绑定）的每一次变化都留下一条记录，按时间排成时间轴，可以随时查看当时的完整价目、与上一次的差异，并从任一记录恢复；
- 店家可以把一份完整的目标价目排到某个时刻，到点一次原子地生效；排着的计划显示在同一条时间轴的未来一侧；
- 店里「设时间」的入口只剩两种，语义不重叠：
  - **时段**：一天 / 一周里、哪些特殊日子怎么收（星期、指定日期、钟点）——重复的日历；
  - **调价计划**：整套价目从哪一刻起换——一次性的切换；
- 退役时段上的 `dateTimeRange` 编辑入口。

已定：

- 到点时在店的玩家沿用现有行为：按入场锁定的版本直到结账，离场后再入场才用新价目；
- 待生效计划数量不设上限，同一时刻只能有一个。

非目标：周期性调价、优惠券 / 商品 / 插件计费的记录。

## 3. 概念

| 名称 | 说明 |
| --- | --- |
| 价目（snapshot） | 一家店某一刻的全部计费规则配置（`pricing_configs` 全部行，含已停用、已归档）+ 全部资源计费绑定（资源组规则、资源专属规则、麻将桌规则） |
| 修改记录（change） | 价目的一次变化。来源：直接编辑、调价计划生效、恢复、数据导入、迁移 |
| 调价计划 | 生效时刻在未来、尚未执行的修改记录，保存**完整的目标价目**，不是差异 |

一切价目变化都是一条修改记录；时间轴就是这张表按时间排序。恢复也只是新增一条记录，从不改写或删除历史。

## 4. 数据

新迁移 `00xx_pricing_changes.sql`，同时加入本地 SQLite schema：

```sql
CREATE TABLE IF NOT EXISTS pricing_changes (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','cancelled')),
  source TEXT NOT NULL CHECK (source IN ('edit','schedule','restore','import','history')),
  effective_at TEXT,            -- 计划的生效时刻（UTC）；直接编辑为空
  applied_at TEXT,              -- 实际生效时刻（UTC）
  release_id TEXT,              -- 生效后的 pricing_release_heads，即当时的规则版本集合
  bindings_json TEXT,           -- 生效后的全部资源计费绑定；history 来源为空（当时未记录）
  target_json TEXT,             -- 仅 pending：完整目标价目（规则配置 + 绑定）
  restored_from TEXT,           -- source='restore' 时指向被恢复的记录
  notes_json TEXT,              -- 执行时的自动处理说明，见 §6.2
  note TEXT,
  actor_id TEXT, actor_name TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_changes_pending_at
  ON pricing_changes(shop_id, effective_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pricing_changes_due ON pricing_changes(status, effective_at);
CREATE INDEX IF NOT EXISTS idx_pricing_changes_timeline ON pricing_changes(shop_id, applied_at);
```

- 已生效记录的规则部分不另存：`release_id` 指向现有不可变的 `pricing_releases`，规则配置从 `pricing_config_versions` 读出。只有绑定（不在计费版本里）存成 `bindings_json`；
- 计划还没有版本可引用，所以 `target_json` 存完整配置；生效后清空，改写 `release_id` / `bindings_json`；
- 计划里新建的规则用临时 `draftId` 互相引用（关系、绑定），生效时换成真实 ID；
- 回填：迁移为每个已有 `pricing_releases` 生成一条 `source='history'` 的记录（`applied_at` = 发布的 `created_at`，绑定为空，操作人为空），时间轴上显示「绑定未记录」；
- `pricing_changes` 加入店铺数据导出导入（`packages/server/src/routes/shops/data/shop-data-format.ts`）。

## 5. 写入记录

所有改价目的路径都在**同一个批次**里追加一条 `applied` 记录：

| 路径 | 位置 | `source` |
| --- | --- | --- |
| 新建 / 编辑 / 归档 / 恢复规则 | `packages/server/src/routes/shops/pricing.ts` | `edit` |
| 改资源组规则 | `packages/server/src/routes/platform/merchant-resource-groups.ts` | `edit` |
| 改资源专属规则、麻将桌规则 | `merchant-resources.ts`、`table.ts` | `edit` |
| 调价计划生效 | §6 | `schedule` |
| 从记录恢复并立即生效 | §7 | `restore` |
| 店铺数据导入、prism-neo 导入 | `routes/shops/data/` | `import` |

一次保存只写一行规则，现有触发器生成一个发布；计划生效一次写多行，批次内会产生多个中间发布，记录只引用批次结束时的 head。批次是一个事务，中间发布不会被任何入场绑定。

修改店铺时区也会发布新版本，但不是价目变化，不写记录。

## 6. 调价计划

### 6.1 编辑

新建计划先选生效时刻，草稿从「该时刻的预计价目」开始：当前价目依次替换为更早的每个待生效计划的目标价目。保存时按保存规则的同一套校验检查整个目标价目：`validatePricingConfig`、关系图、归档规则不被目标价目里的绑定或依赖使用。目标价目自身成立，到点不会因为它自己失败。

### 6.2 生效

`applyPricingChange(shopId, changeId)`（`packages/application`），幂等：

1. 非 `pending` 直接返回；
2. 用目标价目替换当前价目，计划外的东西这样处理（写进 `notes_json`，时间轴上显示）：
   - 计划保存后才新建的规则：保留不动；
   - 计划保存后才新建的资源组 / 资源：保留各自的绑定；
   - 目标价目要归档的规则仍被上一条里的资源绑定，或被保留下来的规则依赖：这条规则不归档；
   - 目标价目里绑定的资源组 / 资源已被删除：跳过这一行；
3. 一个批次写入全部规则行、绑定，并把记录改为 `applied`，写 `applied_at`、`release_id`、`bindings_json`。

因此到点不会因校验失败。数据库写入失败时记录保持 `pending`，由下一次触发重试。

### 6.3 何时触发

三层，任何一层先到都执行同一个幂等函数：

1. **ShopHub 闹钟**：保存 / 修改 / 取消计划后，把下一个 `pending` 的 `effective_at` 并入它现有的闹钟时间表（`packages/server/src/durable-objects/shop-hub.ts` 的 `schedule()`）；
2. **入场前补执行**：`resourceBilling.activate` 与麻将入座在取得玩家计费锁前查询 `status='pending' AND effective_at <= now`，有就先执行，保证切换时刻后入场的玩家一定拿到新价目；
3. **整点 cron 兜底**：`worker.scheduled` 扫描所有到期计划。

本地 Bun 运行时没有 Durable Object 闹钟，用第 2、3 层，本地服务另起每分钟的定时器调用同一扫描。

### 6.4 计划排着时直接修改

目标价目是完整副本，计划保存后直接修改的内容到点会被覆盖。为了不悄悄丢掉修改：

- 有待生效计划时直接保存规则或绑定，编辑器先列出受影响的计划：
  - 计划里这一项与修改前的当前值相同（计划没改过它）：默认勾选「一并修改」，同步进计划；
  - 计划本来就改过这一项：默认不勾选，显示两边的值让店家选；
- 同步写入与直接修改同批提交，同步后的计划重新校验，不通过则整次保存拒绝并说明原因。

### 6.5 在店玩家与封顶

不改变版本锁定：切换前入场的玩家整段按旧版本直到结账。被改规则生成新版本后时段封顶从零累计（现有行为）。生效时刻默认取店铺时区次日 00:00；选非零点时提示「当天已封顶的玩家再次入场会重新累计」。

## 7. 修改记录时间轴

「计费规则」页新增「修改记录」，一条纵向时间轴：

```
  未来   ○ 12月31日 00:00  调价计划 · 恢复「普通游玩」原价            [编辑] [取消]
         ○ 12月1日 00:00   调价计划 · 改 3 条规则、2 个资源组        [编辑] [取消]
  ─────  ● 现在
  过去   ● 11月24日 15:02  店长A 直接编辑 · 普通游玩 日间 12 → 13 元/h
         ● 11月20日 00:00  调价计划生效 · 新建「八口机加价」…   ⓘ 1 项自动处理
         ● 11月3日 10:41   店长A 资源计费 · 音游区 普通游玩 → 音游专用
         ● 10月1日 …       （绑定未记录）
```

- 每条摘要由与上一条记录的差异生成：规则新建 / 归档 / 启停、时段增删、价格与封顶变化、关系变化、绑定变化；
- 点开一条：
  - 「改动」：逐项差异；
  - 「当时的价目」：只读展示完整规则表和资源计费，可在计费模拟器里用它试算；
  - 「仍在使用」：仍按这个版本计费的在店玩家数（`session_pricing_releases` 中未结账的绑定）；
  - 「以此恢复」：打开一个草稿，内容为那时的价目；之后才新建的规则在草稿里标为「将归档」（仍被使用的除外），店家可继续修改，然后选「立即生效」或「排到某个时刻」。立即生效写 `source='restore'`，排期就是普通计划；
- 直接编辑的记录在时间轴上合并显示：同一操作人 10 分钟内的连续编辑折叠为一组，展开可看每一条。

## 8. 时段编辑器与 `dateTimeRange` 退役

- 删除「生效时间 / 结束时间」两个输入框；
- 带 `dateTimeRange` 的旧时段（只来自 prism-neo 导入）改为只读一行：「旧系统导入的一次性时段：2025-10-01 10:00 – 10-07 22:00」，已过期加标签与「移除」按钮；
- 计费引擎与结算保留读取，历史版本与未结账入场可能用到；
- 保存规则（直接编辑与计划）时，带 `dateTimeRange` 的时段必须与当前版本同 ID 时段完全相同，否则拒绝 `PRICING_RULE_DATE_TIME_RANGE_RETIRED`；
- 「指定日期」从逗号文本框改为日期选择 + 标签列表（第三阶段）。

## 9. 接口

均在 `/api/v1/shops/:shopCode/pricing/changes` 下，需商家写权限（查看需读权限）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/?before=&limit=` | 时间轴：全部 `pending` + 分页的已生效记录与摘要 |
| GET | `/:id` | 一条记录的完整价目、与上一条的差异、仍在使用的玩家数 |
| GET | `/projected?at=` | 某时刻的预计价目，供新建计划草稿 |
| POST | `/preview` | 传目标价目与可选 `effectiveAt`，返回差异、校验结果、在店玩家数、到点自动处理预估；不写库 |
| POST | `/` | 新建：有 `effectiveAt` 为计划，没有则立即生效（恢复用） |
| PATCH | `/:id` | 修改计划的时刻、备注、目标价目；仅 `pending` |
| POST | `/:id/cancel` | 取消计划（记录保留，状态 `cancelled`） |
| POST | `/:id/apply-now` | 计划立即生效 |

直接编辑接口（`PATCH /pricing/:id` 与资源绑定接口）新增可选 `syncPendingChangeIds`，即 §6.4 中勾选同步的计划。

错误码：`PRICING_CHANGE_IN_PAST`、`PRICING_CHANGE_TIME_TAKEN`、`PRICING_CHANGE_NOT_PENDING`、`PRICING_RULE_DATE_TIME_RANGE_RETIRED`，以及复用规则保存的全部校验码。

## 10. 分阶段

1. 后端：`pricing_changes` 表与回填、各写入路径追加记录、计划的保存 / 校验 / 生效 / 三层触发、直接编辑同步计划、`dateTimeRange` 保存校验、接口；
2. 前端：修改记录时间轴（含未来计划）、草稿模式（规则表 + 资源计费区块 + 模拟器）、改动预览、直接编辑时的同步提示、恢复、时段编辑器只读旧时段；
3. 「指定日期」改为日期选择器。

阶段 1、2 一起上线。

## 11. 测试

- `application`：预计价目计算、目标价目校验、计划外内容的四种自动处理、幂等、多计划顺序、`draftId` 替换、直接编辑同步计划、恢复草稿中后来新建的规则标为归档；
- `storage-sql` / `adapter-sqlite` / `adapter-d1`：迁移与回填、部分唯一索引、多行批次后 head 正确、入场只绑到最终发布、各写入路径与记录同批回滚；
- `server`：接口权限与店铺隔离、入场前补执行、cron 兜底、绑定接口写记录、`dateTimeRange` 拒绝 / 放行、数据导出导入含记录；
- `prism-web`：差异摘要、时区显示与 `effectiveAt` 往返、草稿模式不调用即时保存接口。
