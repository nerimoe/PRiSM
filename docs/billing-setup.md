# 已有店铺转换为计费店铺

店铺负责人打开 React 商户工作台的「设置」，在「营业与计费」分类点击「转换为计费店铺」。此入口只在店铺未启用计费时显示，manager/viewer 不能执行转换。

1. 填写充值余额和赠送余额的名称、每小时单价、宽限分钟与全天封顶金额。金额以元为单位，封顶填 `0` 表示不封顶。
2. 可勾选「同时启用前台收银」；默认不勾选，转换后也可以在设置中单独打开。
3. 核对收费标准，点击「确认转换并启用计费」。系统补齐基础余额资产、创建全天「标准入场」计费方案并选为店铺入场规则，同时启用计费。完成后工作台立即显示在店、玩家、计费、资产和记录页面。

转换保留店铺编号、设备、玩家、资产数量、历史记录和已有计费方案；已有 `currency/paid`、`currency/free` 资产直接复用，其名称不会被覆盖。新的标准入场方案成为默认入场规则，旧方案仍可在「计费」中管理。店铺原有位置校验、QQ 自动注册开关及联系信息也会保留。若基础余额资产已归档，先在「资产」页面恢复，再执行转换。

不需要创建 Bot 凭据，也不需要连接 Bot 才能启用计费。需要 平台身份验证或 Bot 集成时，负责人可到「接入凭据」单独创建相应用途的凭据。新建计费店铺的「创建 Bot 接入凭据（可选）」默认不勾选，仅主动勾选才创建凭据并显示连接步骤。

手动启用计费仍可使用原有「启用入场计费」开关，但须有有效余额资产并选中有效入场计费规则；这些条件不包含 Bot 凭据。前台收银仅保存计时档案、不为玩家保存资产，店铺的基础资产定义不代表卡片档案有预存余额。详见 [前台收银](cashier.md)。

## 平台接口

`POST /api/v1/shops/:shopCode/billing/setup`，需要商户会话及店铺 owner 权限：

```json
{
  "paidName": "余额",
  "freeName": "赠送余额",
  "hourlyPrice": 12,
  "graceMinutes": 5,
  "dailyCap": 60,
  "cashierEnabled": false,
  "operationId": "00000000-0000-4000-8000-000000000001"
}
```

`cashierEnabled` 可省略，默认 `false`。响应使用标准 `data` 包裹，包含已保存的店铺计费设置及 `pricingConfigId`。所有配置在同一 D1 事务中提交；设置更新、转换和前台操作共用店铺操作锁。相同 UUID 和请求参数可重放成功响应，不会重复创建配置；不同 UUID 对已启用计费的店铺再次转换返回 `409 BILLING_ALREADY_ENABLED`。归档基础资产返回 `409 BILLING_ASSETS_ARCHIVED`，请求编号被用于不同参数返回 `409 OPERATION_CONFLICT`。

`POST /api/v1/merchant/shops` 的 `billingSetup.createBotToken` 默认 `false`，未主动选择时不创建集成凭据，响应 `botToken: null`；显式 `true` 时创建凭据并仅在该响应返回明文 token。

验证：`bun test packages/platform/test/billing-setup.test.ts --timeout 60000`、`bun run typecheck`、`bun run build:web`。平台集成测试使用真实 Miniflare D1，覆盖无 Bot 启用、数据保留、权限、重放、前台收款和事务回滚。
