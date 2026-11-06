# 玩家扫码页

扫码页长什么样只由平台决定。`packages/server/src/resources/page.ts` 的 `renderPage` 是唯一生成页面的地方，客户端（网页、App Clip）只负责把它画出来。日常改按钮、文案、显示条件不需要发 App Clip。

## 接口

```
GET  /api/v1/devices/session/page?ticket=
POST /api/v1/devices/session/action   { ticket, operationId, action, payload?, location? }
```

读页面得到：

```jsonc
{
  "shop": "E2E 店", "shopCode": "e2e-shop", "heroUrl": null,
  "resource": "舞萌", "publicId": "SHHZ...",
  "billingActive": true,
  "blocks": [
    { "kind": "cards", "id": "cards", "enabled": true, "capture": true, "action": "card.swipe", "needsLocation": false },
    { "kind": "button", "id": "coin", "label": "达到机台投币上限", "icon": "coin", "enabled": false, "action": "coin", "needsLocation": false }
  ]
}
```

操作的回答：

```jsonc
{
  "ok": true,            // false 表示被拒绝，原因在 notices 里
  "page": { /* 操作之后的整页 */ },
  "notices": [ /* 显示在刚按的那个按钮下面 */ ],
  "code": { "title": "开门密码", "value": "1234", "expiresAt": "...", "expiresLabel": "有效期至", "hint": "..." } // 只有拿到门锁密码时才有
}
```

被拒绝（投币到上限、位置不对、冷却中）是正常回答，状态码 200，带上最新页面。只有页面答不了的才是错误：登录或票据失效（`notice.flow` 是 `signin` / `expired`），以及 5xx，包括设备连不上时的 502。

## 客户端的约定

- 不认识的 `kind` 跳过，这样新增一种块不会弄坏旧版本。
- 用 `id` 对应前后两次读到的块，勾了一半的同意框、转圈的按钮不会被重置。这类临时状态留在客户端。
- 按钮有 `requires` 时，对应的块同意之后才能按，并在 `payload` 里带上 `consent: true`。
- 有 `needsLocation` 时带上 `location`。入场和门禁看 `checkin_geo`，其他看 `machine_geo`。
- `code` 显示在按钮上方直到过期，它只存在于这次回答里，重读页面不会再给。`againLabel` 在此期间替换按钮文字。
- 卡片不在页面里：`cards` 块只标明位置，卡片在打开页面和添加卡片之后单独读。

## 操作怎么执行

`/session/action` 把操作转成一次内部请求，交给原来的路由：

| action | 路由 |
| --- | --- |
| `entry` | `POST /api/v1/shops/:code/player/session/start` |
| `card.swipe` | `POST /api/v1/machines/login` |
| 其他 | `POST /api/v1/devices/session/actions` |

这样挂在旧路由上的东西都不会漏：`operationId` 防重复、限流、实时活动、闲置倒计时。玩家能做什么也和直接调旧路由完全一样。

`card.swipe` 没有自己的 `operationId`，重发就是再刷一次卡，**客户端不能自动重试它**。其他操作用同一个 `operationId` 重发是安全的。

## 开销

测试数据下，确认页 15 次查询，可操作页 12 次（`test/resource-page.test.ts` 里有上限）。比 `/session/state` 多的是投币上限和「有没有在计费」，省下的是客户端原本要单独请求的 `/player/me`。

设备没有 Home Assistant 连接在线时，读页面会当场问 Home Assistant，每项最多等 3 秒。问不到就当状态未知，不挡玩家操作。

## 旧接口

`/session/state`、`/session/bootstrap`、`/session/device`、`/session/actions` 都保留，已发布的 App Clip 继续用它们。
