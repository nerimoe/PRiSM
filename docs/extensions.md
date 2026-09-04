# PRiSM Next 插件与扩展开发指南

PRiSM Next 的扩展接口主要定义在领域规则层。系统遵循的核心规范是：**插件只负责提议事实（Propose Facts），核心库（Core）负责进行安全性校验并持久化状态**。

---

## 1. 核心架构规范

> [!WARNING]
> **严禁在计费或打折插件代码中直接调用仓储库（Repository）或直接修改玩家的资产账户持有状态。**

开发扩展功能时，应当遵循以下特定的契约接口：

- `PricingProvider`：计算并提议新的费用项（Charge Items）。
- `AssetEffectProvider`：根据玩家当前持有的卡券或资产，计算并提议结算折扣调整项（Adjustments）。
- **礼物分发（Present Grants）**：通过礼物兑换系统（Redeem System）来为玩家批量授予或替换资产。
- **员工资产操作**：调用应用层服务（Application Services）以执行人工余额调整或资产撤销。
- **设备命令扩展**：通过业务动作服务创建一条挂起的指令（Command），再由 Machine WebSocket 或设施执行器触发本地硬件。

---

## 2. 计费提供商契约 (Pricing Provider)

计费提供商在结账结算或预览费用时被调用。它接收活跃场次、当前玩家的资产快照和当前时间，并输出非负的费用项（`ChargeItem[]`）。

```ts
import type { PricingProvider } from "@prism/core";

export const roomFeeProvider: PricingProvider = {
  id: "plugin.room-fee",
  quote(context) {
    return [
      {
        id: `${context.session.id}:room-fee`,
        source: "plugin.room-fee",
        label: "包间使用费",
        amount: 300, // 增加 300 日元固定费用
      },
    ];
  },
};
```
除了通过编写插件代码定制复杂的费用逻辑之外，商家也可以直接从 Staff Web 控制台发布简单的「固定收费项目（`charge.fixed`）」，它们会被系统自动解析并附加到结账单中。

---

## 3. 运行时插件容器注册 (Runtime Plugins)

`packages/runtime` 包公开了一个轻量级的插件容器。你可以在容器中定义前端后台的配置卡片信息、固定的计费处理器、根据业务数据动态生成的计费处理器，以及资产打折效果处理器。

```ts
import type { PrismRuntimePlugin } from "@prism/runtime";

export const storePlugin: PrismRuntimePlugin = {
  id: "plugin.my-store",
  // 供 Staff Web 渲染的非计时或折扣项的插件能力声明卡片
  staffCatalog: [
    {
      id: "plugin.my-store.room-fee",
      name: "包间使用费插件",
      kind: "pricing",
      summary: "在玩家结算时追加结算包间费用，从同一钱包扣费。",
      status: "enabled",
      configuredBy: "plugin",
      capabilities: ["结账加项", "包间费", "余额扣费"],
      // 声明本插件需要店铺在资产目录中定义过以下资产
      requiredAssets: [
        {
          type: "entitlement",
          code: "vip-room",
          name: "VIP包间使用权",
        },
      ],
    },
  ],
  // 静态注册的计费提供商
  pricingProviders: [roomFeeProvider],
  // 动态生成的计费提供商（例如需要从数据库查询某种非计时商品的状态）
  createPricingProviders(context) {
    return [
      {
        id: "plugin.my-store.event-entry",
        async quote(quoteContext) {
          // 通过上下文安全只读地列出店铺发布的活跃赛事报名商品
          const items = await context.businessItems.listActive({
            kind: "event.entry",
            now: quoteContext.now,
          });

          return items.map((item) => ({
            id: `${quoteContext.session.id}:${item.id}`,
            source: "plugin.my-store.event-entry",
            label: item.name,
            amount: item.price,
          }));
        },
      },
    ];
  },
  // 注册资产打折效果
  assetEffectProviders: [monthlyPassDiscount],
};
```

### 插件装配挂载方式

**本地单机部署**：在实例化 App 时直接传入插件数组：
```ts
import { Database } from "bun:sqlite";
import { createPrismLocalApp } from "@prism/runtime";
import { storePlugin } from "./store-plugin";

const app = createPrismLocalApp({
  db: new Database("./prism.sqlite"),
  plugins: [storePlugin],
});
```

**Cloudflare Worker 部署**：在 Worker 入口文件的第二个参数中注入：
```ts
import { createPrismWorkerApp, type PrismWorkerEnv } from "@prism/runtime";
import { storePlugin } from "./store-plugin";

export default {
  fetch(request: Request, env: PrismWorkerEnv) {
    return createPrismWorkerApp(env, {
      plugins: [storePlugin],
    }).fetch(request);
  },
};
```

### 插件装配规范
- **加法原则**：注册的插件计费提供商是累加生效的。无论后台是否启用了其他持久化时间计费方案，插件计费都会在结账结算中叠加执行。时间计费规则也可以用负数单价表达叠加抵扣，例如某类麻将桌在标准入场计时之外每小时抵扣固定金额。负数 session 会保留真实计费贡献，系统只在所有待结 session 汇总完成后把最终应付金额限制为不低于 `0`。
- **后台集成（`staffCatalog`）**：插件可以在后台声明自身所需的“前置资产”（如某项月卡卡券或 VIP 资格）。系统会自动检测资产库中是否缺失或归档了这些定义，并在后台展示状态，避免配置失误。
- **纯函数化设计**：计费和折扣计算应当是确定且无外部副作用的。系统通过应用层服务统一扣款，插件禁止自主写入数据。

---

## 4. 资产效果转换契约 (Asset Effect Provider)

资产效果处理器负责**检查玩家当前名下持有的卡券或余额状态，并将其转换成负数的结算折扣调整项（`SettlementAdjustment[]`）**。

PRiSM Next 的内建资产计费效果只读取资产定义关联的 `PricingEffect`。免计费、定额优惠、比例优惠及其作用域、每日次数和生效日期均由该关联定义；任意 `metadata` 字段都不会参与结算。

如需计算复杂的折扣逻辑（例如工作日打折、单设备抵扣券、特定比例优惠等），可在此进行实现：

```ts
import type { AssetEffectProvider } from "@prism/core";

export const monthlyPassDiscount: AssetEffectProvider = {
  id: "plugin.monthly-pass",
  apply(context) {
    // 检查玩家当前名下是否存在 active 且未过期的“包月卡”
    const hasPass = context.assetHoldings.some(
      (holding) => holding.assetType === "pass" && holding.assetCode === "monthly",
    );
    if (!hasPass) return [];

    // 返回将本次计时费用金额清零的调整项
    return [
      {
        id: `${context.session.id}:monthly-pass`,
        source: "plugin.monthly-pass",
        label: "月卡包时抵扣",
        amount: -context.subtotal,
      },
    ];
  },
};
```

---

## 5. 核心资产类型与合并策略

### 常见资产类型 (Asset Types)

| 类型 (Type) | 常见 Code 示例 | 业务语义与作用 |
| --- | --- | --- |
| `currency` | `paid` / `free` | 充值本位钱包余额，结账或消费时自动优先抵扣赠送代币。 |
| `pass` | `monthly` / `night` | 时效性卡券，内建免计时费，亦可由插件深度计算。 |
| `ticket` | `coin-pack` | 凭证代金券，常用于非时间结算抵免。 |
| `title` | `founder` | 可视化的玩家限定称号展示。 |
| `achievement` | `first-session` | 玩家的成就标识，不影响结算。 |
| `entitlement` | `vip-room` | 门禁、设备开启或专属区域的权限标识。 |

设置 `metadata.hiddenFromPlayer: true` 可以在玩家前台资产面板隐藏某些道具或特权资产，但员工后台审计依然可见。

### 资产合并逻辑 (Merge Strategies)

当玩家重复购买或接收同一项资产时，支持如下合并动作：
- `stack`：累加数量。条件是其代号、激活时间与过期时间必须完全一致。
- `extend-time`：延长过期时间。找到最近一个将要过期的持有资产，并基于其过期时间顺延增加 `durationMs` 时长。
- `replace`：直接覆盖。清空旧的数量与过期规则，以新的授予规则为准。

---

## 6. 添加持久化计费规则的开发步骤

添加除 `time.priority` (时间计费) 和 `charge.fixed` (固定费用) 之外的第 3 种后台直接编辑的计费配置时，必须严格执行测试驱动开发（TDD）：

1. 在 `packages/core` 中为新的费用算法编写单元测试。
2. 在 `packages/core/src/pricing-config.ts` 中扩展 `PricingConfigKind` 及相应的配置 TypeScript 类型。
3. 实现对新增计费配置的语法与安全验证（例如防止金额出现负值或配置缺失）。
4. 在 `createPricingProviderFromConfig()` 转换分支中，映射该配置到对应的计费逻辑实现类中。
5. 编写 API 和持久化测试，确保后台服务能够正确读写并在结账解析中引用。
6. 确认 API 和数据底座工作无误后，再行编写前台的 UI 表单。

---

## 7. 非计时商品 (BusinessItem) 与履约订单 (Order) 扩展

场馆除了按照游戏时间计费外，也需要支持销售赛事门票、饮品预约、包间预定或一次性清洁费等服务。

1. **发布商品**：员工在中文后台创建 `BusinessItem`，可声明其价格、库存容量限制（`capacity`）和有效销售时段。
2. **玩家购买**：玩家在活跃场次内，通过 `POST /rpc/player/business-items/:id/purchase` 发送购买指令。
3. **安全处理**：应用服务拦截该请求，核对库存并直接通过同一本位币钱包扣减账户余额，写入 `asset_transactions` 追加记录，产生一条待履行的 `BusinessItemOrder`（状态为 `paid`）。
4. **履约/退款**：商家在 Staff Web 页面核销履行（Fulfill）或进行取消。当前版本的取消操作会回滚库存和生命周期限制，如需实现订单自动退款，需要在应用服务中增加退款规则。
