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

## 推送

页面连 `GET /session/ws?ticket=&v=2`，只会收到一种消息：

```jsonc
{ "method": "event.pageChanged", "params": { "reason": "billing" } }
```

它不带内容，收到后重新读页面。`reason` 只用来排查问题，客户端不要按它做判断。连上时 Hub 什么也不发、什么也不读。重连之后页面自己读一次，第一次连上时如果页面刚读过就不用再读。保活还是纯文本 `ping` / `pong`。

WebSocket 不保证送达，所以页面在回到前台时、以及可见期间每 60 秒也会读一次。

| 范围 | 什么时候发 | reason |
| --- | --- | --- |
| 玩家 | 入场、结账、停用，以及其他写这个玩家的店铺接口；Bot 命令 | `billing` |
| 玩家 | 上下麻将桌，同时通知所有麻将桌的页面 | `seat` |
| 用户 | 绑定平台身份成功 | `binding` |
| 设备 | 机台到达或离开投币上限，包括 IO 掉线 | `coin` |
| 设备 | 电源、空调状态变化 | `device` |
| 全店 | 改资源、资源组、定价方案、店铺设置 | `shop` |

不发的情况：单纯投币且没有跨过上限（币数不在页面上）、账单金额变化、时间流逝。

玩家自己操作时，推送可能和操作的回答一起到，页面会多读一次。这种情况很少，所以没有特别处理。

发通知都走 `shop-hub-client.ts` 的 `pagesChanged`。Hub 只负责转发，不计算页面。

已知的延迟：商户改投币上限后，机台保存的「是否到上限」要等下一次币数变化或连接变化才更新。这段时间里如果 IO 掉线，页面可能最多晚 60 秒才更新。

旧客户端不带 `v=2`，仍然收到原来的 `hello` / `state` / `refresh`，不受影响。

## 操作怎么执行

`/session/action` 把操作转成一次内部请求，交给原来的路由：

| action | 路由 |
| --- | --- |
| `entry` | `POST /api/v1/shops/:code/player/session/start` |
| `card.swipe` | `POST /api/v1/machines/login` |
| 其他 | `POST /api/v1/devices/session/actions` |

这样挂在旧路由上的东西都不会漏：`operationId` 防重复、限流、实时活动、闲置倒计时。玩家能做什么也和直接调旧路由完全一样。

所有操作用同一个 `operationId` 重发都是安全的，只会执行一次并拿到第一次的回答。还在执行时重发，`notices` 里是 `OPERATION_PENDING`，隔一会儿再问。旧客户端刷卡不带 `operationId`，行为不变。

## 开销

测试数据下，确认页 15 次查询，可操作页 12 次（`test/resource-page.test.ts` 里有上限）。比 `/session/state` 多的是投币上限和「有没有在计费」，省下的是客户端原本要单独请求的 `/player/me`。

设备没有 Home Assistant 连接在线时，读页面会当场问 Home Assistant，每项最多等 3 秒。问不到就当状态未知，不挡玩家操作。

## 旧接口

`/session/state`、`/session/bootstrap`、`/session/device`、`/session/actions` 都保留，已发布的 App Clip 继续用它们。
