# 截图中的入场失败与时区

> 以下记录 `4400b2b` 的历史问题分析。当前已实现 [UTC 业务与 UI 转换](utc-time-contract.md)，并修正未配置区间被时间轴延长显示的问题；复现脚本现在验证修复后的行为。

改动前分析基于主仓库 `4400b2b`，使用内存 SQLite 和真实运行时复现截图参数。当前 `bun run scripts/reproduce-pricing-timezone.ts` 验证修复后的行为：上海 UI 10:00–03:00 转为 UTC 02:00–19:00，10:08–11:54 收费 36 元且允许入场，切换 UI 时区不改变费用或发布版本。

改动前，三个场景及保存时区后的版本锁定断言均通过；`bun run typecheck` 通过，`bun test --timeout 30000` 全量 602 项测试通过（0 失败）。

## 结论及证据

截图中列表入场为 10:08，账单开始为 02:08，相差 8 小时。规则为每天 10:00–次日 03:00，03:00–10:00 未配置。使用缺少 `store.profile.timeZone`、方案未显式指定时区的店铺，能够复现截图的全部关键现象：北京时间 10:08 入场成功、北京时间 11:54 新玩家入场失败、时间轴显示 02:08–03:54、106 分钟但只收 18 元。

| 条件 | 11:54（北京时间）新玩家入场 | 原玩家 10:08–11:54 的费用 | 账单显示 |
| --- | --- | --- | --- |
| 店铺及方案均未写入时区 | 拒绝，`PLAYER_SESSION_OUTSIDE_BILLABLE_TIME` | 18 元 | 02:08–03:54 |
| 店铺明确写入 `Asia/Shanghai`，方案继承 | 成功 | 36 元 | 10:08–11:54 |
| 店铺为上海，但方案显式为 UTC | 拒绝 | 18 元 | 02:08–03:54 |

三个场景均只有一个方案，每 60 分钟 18 元，余数宽限 10 分钟、封顶 90 元，不设置优惠。截图不能单独证明生产店铺具体缺少哪个字段，但上述缺省路径已经在本地确认；应检查实际存储而不是只看页面显示的默认值。

## 默认值为什么不一致

- `packages/platform/src/billing.ts` 的 `getBillingShop` 在店铺配置缺少时区时对页面使用 `Asia/Shanghai`，计费规则日预览也继承该值。
- `packages/application/src/settings.ts` 的设置读取同样显示 `Asia/Shanghai` 默认值；读取不等于写入 `app_settings`。
- `packages/runtime/src/index.ts` 的入场检查直接读取 `store.profile.timeZone`。新玩家没有旧会话且配置缺失时传入 `undefined`，计费核心最终使用 UTC。方案自身的 `provider.timeZone` 优先级更高。
- `packages/storage-sql/src/pricing-version-schema.ts` 生成发布版本时按 `venue.operations.timeZone → store.profile.timeZone → UTC` 选择时区，并在入场时锁定此版本。旧的 `venue.operations` 中若仍有时区字段，也可能与当前店铺设置不一致。
- `packages/platform/src/billing-setup.ts` 建立方案和基础资产，但未写入 `store.profile`。平台新建计费店铺和旧店铺转换路径调用它，因此默认时区缺失可以由正常初始化路径产生。
- `packages/application/src/bill-timeline.ts` 根据收费明细中的 `pricingExplanation.timeZone` 生成时间标签，前端 `BillTimeline` 直接显示后端提供的时间；列表则按页面的店铺时区格式化同一个 ISO 时间。

因此，这不是简单的操作系统时钟偏差：同一个绝对时刻被不同入口按不同业务时区解释。

## 为什么 10:08 能进、11:54 不能进

北京时间 10:08 是 UTC 02:08，仍在 UTC 10:00–次日 03:00 的凌晨部分，所以可以入场。北京时间 11:54 是 UTC 03:54，落入 UTC 03:00–10:00 的空白区间，因而被拒绝。

这条 UTC 规则实际等价于北京时间 18:00–次日 11:00。若店铺意图是北京时间 10:00–次日 03:00，就发生了真实的营业时间错判。

原玩家只被计入 UTC 02:08–03:00（52 分钟），所以收费 18 元。之前确认的账单末段显示问题，又把其结束时间延长到 UTC 03:54，界面因此显示 106 分钟但仍为 1 个收费单位。正确上海时区下实际在营业区间停留 106 分钟，按截图单位和宽限应计 2 个单位，即 36 元。这修正了此前“只发现显示问题”的范围：此前测试明确写入上海时区；截图暴露的时区缺省路径会影响入场和收费本身。

## 旧配置的只读检查

用实际店铺内部 ID 替换参数，以下均为只读查询：

```sql
SELECT key, json_extract(value_json, '$.timeZone') AS time_zone
FROM app_settings
WHERE shop_id = :shop_id AND key IN ('store.profile', 'venue.operations');

SELECT id, name, json_extract(provider_json, '$.timeZone') AS provider_time_zone
FROM pricing_configs
WHERE shop_id = :shop_id;

SELECT s.id AS session_id, r.id AS release_id, r.time_zone
FROM sessions s
JOIN session_pricing_releases b ON b.shop_id = s.shop_id AND b.session_id = s.id
JOIN pricing_releases r ON r.shop_id = b.shop_id AND r.id = b.release_id
WHERE s.shop_id = :shop_id AND s.payment_status = 'unpaid';
```

## 当前修复

业务统一 UTC，店铺时区只控制 UI。规则输入／展示在 UI 转换，保存、预览执行和入场检查使用 UTC；时间轴按收费实际结束时间展示空档。新发布固定为 UTC，修改 UI 时区不再发布新版本。

旧会话继续绑定同一个历史发布 ID，历史规则等价转换成 UTC；已结账金额不重算，快照中的时间标签与解释统一为 UTC。升级前未标时区的 10:00–03:00 若原本按 UTC 执行，升级后上海 UI 显示为 18:00–次日 11:00；店铺若希望上海 10:00–次日 03:00，应在编辑器中明确输入并保存所需区间。完整约定和迁移说明见 [UTC 时间约定](utc-time-contract.md)。
