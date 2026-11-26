# 玩家扫码页

扫码页长什么样只由平台决定。`packages/server/src/resources/page.ts` 是唯一决定页面内容的地方，客户端（网页、App Clip）只负责把它画出来。日常改按钮、文案、表单、布局或显示条件不需要发客户端。

## 代码在哪

| 内容 | 位置 |
| --- | --- |
| 区块类型、容器遍历、表单校验与提交内容、图片地址规则 | `packages/page-protocol`（服务端与网页共用同一份） |
| 决定显示哪些区块 | `packages/server/src/resources/page.ts`（扫码页）、`shop-page.ts`（店铺主页与账号面板页） |
| 各业务区块怎么填 | `packages/server/src/resources/page-blocks/` |
| 页面文案与英文翻译、绑定提示渲染 | `packages/server/src/resources/page-text.ts` |
| 区块构造器 `pageUi`（原有页面也用它构造基础区块） | `packages/server/src/resources/page-ui.ts` |
| 网页渲染：一类区块一个组件，`BlockView.tsx` 分发 | `packages/prism-web/src/ui/page-blocks/`（`ShopPage.tsx`、`PlayerAccount.tsx`、`PlayerAccountMenu.tsx` 共用） |
| App Clip：模型 `PrismPage.swift`、表单规则 `PrismPageForm.swift`、一类区块一个视图 | `hinata_go` 仓库 `ios/PrismClip/`（视图在 `Page/`，`ClipPageView.swift` 分发） |

新增一种区块：在 `page-protocol` 加类型，两端各加一个组件并在分发处加一行，App Clip 的 `PrismPage.swift` 同步模型。只用现有区块拼新页面则只改服务端。

改了页面的结构后，重新生成 App Clip 原生检查用的页面数据，并在 `hinata_go` 跑 `test/native/run-prism-visit-check.sh`：

```sh
bun scripts/swift-page-fixtures.ts <hinata_go>/test/native/fixtures/prism-page
```

数据由服务端真实的 `renderPage` 生成；检查会解码每一页，Swift 模型读不懂任何一个区块就失败。新增场景加在脚本里。

## 接口

```
GET  /api/v1/devices/session/page?ticket=
POST /api/v1/devices/session/action   { ticket, operationId, action, payload?, location? }

GET  /api/v1/shops/:shopCode/player/page?view=shop|bill|redeem|history|wallet|bindings[&item=][&cursor=]
POST /api/v1/shops/:shopCode/player/action   { view?, operationId, action, payload?, location? }
```

读页面得到：

```jsonc
{
  "shop": "E2E 店", "shopCode": "e2e-shop", "heroUrl": null,
  "resource": "舞萌", "publicId": "SHHZ...",
  "billingActive": true,
  "offerPasskeySetup": true, // 有可用的东西时，刚登录的玩家可以先被引导添加 Passkey（仅网页使用）
  "blocks": [
    {
      "kind": "cards", "id": "cards", "enabled": true, "capture": true,
      "action": "card.swipe", "needsLocation": false,
      "title": "选择卡片", "loadingLabel": "正在加载卡片", "locatingLabel": "确认位置…",
      "swipingLabel": "正在登录…", "endingTemplate": "尾号 {digits}",
      "empty": {
        "text": "还没有可用卡片，请先添加卡片",
        "actions": [
          { "id": "capture", "label": "添加卡片", "action": "cards.capture" },
          { "id": "refresh", "label": "刷新", "action": "cards.reload" }
        ]
      },
      "loadError": {
        "title": "无法加载卡片",
        "actions": [{ "id": "refresh", "label": "刷新", "action": "cards.reload", "style": "primary" }]
      },
      "captureUi": {
        "title": "添加卡片", "addLabel": "添加卡片", "startingText": "正在连接机台…",
        "waitingText": "请把卡片放在「舞萌」的读卡器上", "cancelLabel": "取消", "doneLabel": "完成",
        "leftPageText": "离开页面后已取消添加，请重新添加",
        "outcomes": {
          "added": "已添加卡片",
          "taken": "这张卡已绑定到本店的其他玩家",
          "unsupported": "不支持这种卡片",
          "expired": "没有读到卡片"
        }
      }
    },
    {
      "kind": "button", "id": "coin", "label": "达到机台投币上限", "icon": "coin",
      "enabled": false, "action": "coin", "answerOnButton": true,
      "hideDuringCapture": true, "needsLocation": false
    }
  ]
}
```

操作的回答：

```jsonc
{
  "ok": true,            // false 表示被拒绝，原因在 notices 里
  "page": { /* 操作之后的整页 */ },
  "notices": [ /* 显示在刚按的那个按钮下面 */ ],
  "code": { "title": "开门密码", "value": "1234", "expiresAt": "...", "expiresLabel": "有效期至", "hint": "..." }, // 只有拿到门锁密码时才有
  "celebration": { "title": "结账成功", "subtitle": "计费已结束，离店前无需再做其他操作。", "effect": "checkout" }, // 结账成功等全屏动效
  "receipt": { /* 结账回执（如 checkout.confirm） */ }
}
```

页面模型同时支持可选的 `title`、`backLabel`（列表下钻详情返回文案；省略或为空时客户端仅显示返回图标）、`footer`（吸底动作区，如结账按钮；表单校验与 `blocks` 通过 `allPageBlocks(page)` 一并收集）和 `accountMenu`（顶部账号菜单的「计费中」徽章、可见页签与退出文案，扫码页与店铺主页登录态均由服务端下发，因此后续新增常规菜单项只需服务端下发新 `tabs` 条目与对应 `view` 页面，无需更新客户端）。

被拒绝（投币到上限、位置不对、冷却中、余额不足、无效兑换码）是正常回答，状态码 200，带上最新页面。只有页面答不了的才是错误：登录或票据失效（`notice.flow` 是 `signin` / `expired`），以及 5xx，包括设备连不上时的 502。

## 声明式 UI 原语（SDUI）

除了既有的业务专有块（`signin`、`binding`、`pricing`、`climate`、`table`/`mahjong`、`cards`、`consent`），协议提供一套通用的声明式布局、展示、表单与按钮组合原语。服务端可通过 `packages/server/src/resources/page-ui.ts` 导出的 `pageUi` 构造器在 `/session/page` 与 `/shops/:shopCode/player/page` 内任意拼装新画面，而无需新建客户端页面或路由。其中店铺账号面板的「身份」页只读展示已绑定身份（不附加刷新按钮），「钱包」页自动将充值余额（`paid`）与赠送余额（`free`）置顶并附带类型图标与着色标签胶囊。

### 布局与展示块

- `bill`: `{ kind: "bill", id, mode: "live" | "settled", timeZone?, billingInputs?, preview?, settledAt?, balanceAfter?, labels }` — 账单展示块；实时计费默认下发 `billingInputs` 由浏览器 Web Worker / App Clip `PrismCheckoutEngine` 本地算价预览，服务端插件运行时不支持离线算价时退回下发 `preview`，已结账单直接带 `preview`、`settledAt` 与 `balanceAfter`。
- `list`: `{ kind: "list", id, items, timeZone?, emptyText?, emptyIcon?, moreLabel?, moreTarget? }` — 列表块（如结账记录）；列表项支持 `group`（连续同组名合并为带标题的轻卡片分组）、`titleMeta`（标题右侧浅灰补充，如停留时长）、`trailingStrikethrough`（右侧金额下方删除线原价）、`titleTimestamp` / `subtitleTimestamp`、下钻跳转 `open: { view, item? }` 以及分页加载 `moreTarget: { view, cursor? }`。其中「记录」页按门店时区的结账日（`settledAt`）以轻卡片分组，并在副标题展示结算方式、多段项数与（跨分钟时）实际结账时刻。
- `section`: `{ kind: "section", id, title?, subtitle?, style?: "card" | "plain", blocks: PageBlock[] }` — 纵向容器；`style: "card"` 渲染圆角面板。嵌套在 `card` 分区或 Sheet 弹窗内的输入框与内层卡片控件（含网页与 App Clip）会自动切换为浅层嵌入式填充色并保持分组标题左对齐，确保与外层卡片形成清晰边界。
- `row`: `{ kind: "row", id, blocks: PageBlock[] }` — 横向等宽排列容器（窄屏 Web 自动换行，iOS 使用 `HStack`）。
- `kv`: `{ kind: "kv", id, items: Array<{ id?, label, value, tone?: "default" | "muted" | "accent" | "success" | "warning" | "error" | "purple", icon?: "wallet" | "gift" | "coins" | "coupon" | "pass" | "ticket" | "asset", badge?: string, badgeTone?: PageTone }> }` — 键值对列表（身份、钱包资产、状态摘要）；携带 `icon` 或 `badge` 时渲染左图标与标签胶囊。
- `banner`: `{ kind: "banner", id, title?, body, level?: "info" | "success" | "warning" | "error" }` — 带图标的提示横幅。
- `divider`: `{ kind: "divider", id }` — 分割线。
- `image`: `{ kind: "image", id, url, alt?, aspectRatio? }` — 图片展示（客户端仅允许站内 `/...` 相对路径（非 `//`）、`https://` 或同源 `http://`；拒绝 `javascript:`、`data:`、`file:` 与跨源 `http://`）。
- `text`: `{ kind: "text", id, text, style?: "heading" | "body" | "caption", level?: "error" | "muted" }` — 文本块；省略 `style` 时保持居中副标题外观，`body`/`caption` 为左对齐正文与小字说明。

### 表单输入块

- `input`: `{ kind: "input", id, name?, label?, placeholder?, inputType?: "text" | "number", defaultValue?, required?, maxLength?, helperText?, enabled? }` — 文本或数字输入；提交值始终为 `string` 以保留前导零，`inputType: "number"` 切换数字键盘。
- `select`: `{ kind: "select", id, name?, label?, style?: "list" | "segmented", options: Array<{ value, label, detail?, disabled? }>, defaultValue?, required?, enabled? }` — 单选列表或分段选择器。
- `toggle`: `{ kind: "toggle", id, name?, label, description?, defaultValue?, required?, enabled? }` — 开关控件。

### `button` 扩展能力

- `icon`: 支持语义图标 `coin` | `power` | `door` | `plus` | `refresh` | `check` | `lock` | `info` | `warning` | `close` | `arrow-right`。
- `style`: `"primary"` | `"destructive"`（危险/取消动作样式）。
- `collect?: string[]`: 声明提交时需要校验并采集的表单块 `id` 列表（支持 `input`、`select`、`toggle`、`consent`）。
- `confirm?: { title, body, confirmLabel, cancelLabel, destructive? }`: 点击后先弹出原生确认弹窗（Web 使用 `PlayerDialog`，iOS 使用 `.alert`），用户确认后才发送 `/session/action`。

### `pageUi` 用法示例

```ts
import { pageUi } from "../resources/page-ui.js";

const blocks = [
  pageUi.banner("tips", "请确认时段后提交", { level: "info" }),
  pageUi.section("booking", [
    pageUi.kv("info", [{ label: "当前状态", value: "可预约", tone: "success" }]),
    pageUi.select("slot", [
      { value: "14:00", label: "14:00 - 15:00", detail: "余 2 位" },
    ], { name: "slot", label: "时段", required: true }),
    pageUi.input("remark", { name: "remark", label: "备注", maxLength: 30 }),
    pageUi.button("submit", "确认预约", "booking.create", {
      icon: "check",
      style: "primary",
      collect: ["slot", "remark"],
      confirm: { title: "确认预约", body: "提交后将锁定名额", confirmLabel: "确认", cancelLabel: "取消" },
    }),
  ], { title: "预约", style: "card" }),
];
```

## 客户端的约定

- 不认识的 `kind`、图标名、子动作（如 `cards` 动作、`signin.methods[].provider`）直接跳过，这样新增块或交互不会弄坏旧版本。
- 容器递归深度上限为 8 层（`MAX_PAGE_DEPTH = 8`），客户端在遍历与渲染时均强制截断，避免深层嵌套导致异常。
- 所有块的可见文案、按钮标签、状态提示、操作动作与列表顺序均由服务端随页面下发（按请求 `Accept-Language` 翻译）：
  - `signin` 下发 `methods`（`provider`: `munet` / `passkey`、标签、加载中文案及 Passkey 不可用提示）。
  - `binding` 下发标题、过期标签、复制/已复制/重试文案；引导文字与指令由 `POST /api/v1/shops/:code/platform-binding` 返回的 `lines` 给出。
  - `pricing` 下发 `labels`（标题、跨方案封顶、确认后结束、新增/保留标签、单次收取、不计费/未覆盖/不封顶/封顶文案与列表分隔符）。
  - `climate` 下发标题、状态文案（含 `roomText`、`currentModeLabel`）、按钮标签、可选 `modes`（含语义图标 `cool`/`heat`/`dry`/`fan`/`auto`）、`fanModes` 及动作名 `actions`。
  - `button` 支持 `hideDuringCapture`（添加卡片期间隐藏，例如投币按钮）和 `wait`（`{ ms, timeoutMessage }`，如开机按钮等待设备回报并在超时后提示）。
  - `table` 下发标题、状态、容量、空位标签、`mineLabel` 和座位列表（客户端同时兼容旧名 `mahjong`）。
- 客户端不为页面区块保留备用文案或备用判断：协议里的必填字段缺失时，该区块按看不懂处理、整块跳过。所以给区块新增必填字段时，**服务端必须先于 App Clip 发布，且不能回滚到不下发该字段的版本**。旧版 App Clip 忽略新字段，可以直接连新服务端。网页和服务端一起部署。
- 只用于补充说明的字段读不懂时不能连累整块：`pricing.changes` 读不懂时照常显示计费规则（只是没有新增/保留/结束标记）；`climate.state` 读不懂时按状态未知显示开、关按钮。
- 用 `id` 对应前后两次读到的块：在场的同意框与表单控件（`input`、`select`、`toggle`、`consent`）保留玩家当前输入，新出现的表单按 `defaultValue` 初始化，已离开页面的字段 `id` 自动清理（再次回到该步骤时重新开始）；转圈与等待状态也按 `id` 保持在客户端。
- 校验与提交规则：
  - 按钮有 `requires` 时，对应的块同意之后才能按；`collect` 中的必填项（`consent` 须勾选，`input` `required` 须非空，`select` `required` 须选中可用项，`toggle` `required` 须开启）未满足时按钮保持禁用。禁用态主按钮在网页端与 App Clip 端统一采用中性灰底与弱化灰字表现（不保留高饱和强调色）。
  - 当页面中仅有唯一一个按钮在 `collect` 中收集某个 `input` 块且满足提交条件时，输入框回车 / 键盘提交可直接触发该按钮（带 `confirm` 时不绕过确认框）。
  - 发送 `payload` 的合并优先级为：先按 `field.name ?? field.id` 写入 `collect` 收集的值，再用静态 `button.payload` 覆盖，若存在 `requires` 则再写入 `consent: true`（防止用户输入覆盖服务端签名字段）。
- `footer` 区的按钮内联提示（`inline` notice）显示在吸底按钮上方并带不透明卡片背景（Web 与 App Clip 一致）。
- 有 `needsLocation` 时带上 `location`。入场和门禁看 `checkin_geo`，其他看 `machine_geo`。
- `code` 显示在按钮上方直到过期，它只存在于这次回答里，重读页面不会再给。`againLabel` 在此期间替换按钮文字。
- 卡片不在页面里：`cards` 块只标明位置并下发卡片区域的全部文案、加载/空态/失败动作（`cards.capture` 与 `cards.reload`）以及读卡窗口文案 `captureUi`；卡片本身在打开页面和添加卡片之后单独读。没有可用卡片时按服务器下发的动作渲染按钮（直连机台下发「添加卡片」与「刷新」，其余只下发「刷新」），绝不跳往 `/cards`。
- 卡片读取失败时，页面只显示 `loadError` 的标题、错误原因和它的动作（服务端只下发一个主按钮样式的「刷新」）：卡片标题与加号、投币、门禁、空调等其他区块全部不显示，刷新成功后恢复整页。店铺卡片、账户菜单这类页面外的内容不受影响。

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
| 设备 | 直连 IO 连上或断开，页面在「等待机台连接」和刷卡、投币之间切换 | `link` |
| 设备 | 电源、空调状态变化 | `device` |
| 全店 | 改资源、资源组、定价方案、店铺设置 | `shop` |

不发的情况：单纯投币且没有跨过上限（币数不在页面上）、账单金额变化、时间流逝。

玩家自己操作时，推送可能和操作的回答一起到，页面会多读一次。这种情况很少，所以没有特别处理。

发通知都走 `shop-hub-client.ts` 的 `pagesChanged`。Hub 只负责转发，不计算页面。

添加卡片不走这条路，也不轮询。读卡器读到卡时，平台只把卡暂存起来，给等待中的玩家在这台机器上的页面发 `event.cardRead`，其他页面都收不到。客户端收到后调 `GET /session/cards/capture/:id`，这时才真正绑定。页面关了就没人来取，卡在窗口过期后丢弃。页面一旦切到后台，客户端就结束等待、不再来取，所以别人这时刷的卡不会绑定。客户端另外只在重连后和窗口结束时各问一次。

已知的延迟：商户改投币上限后，机台保存的「是否到上限」要等下一次币数变化或连接变化才更新。IO 进程没来得及断开连接就没了的话，平台要等心跳超时（150 秒）才知道它掉线，这段时间页面还会显示刷卡和投币。

旧客户端不带 `v=2`，仍然收到原来的 `hello` / `state` / `refresh`，不受影响。

## 操作怎么执行

`/session/action` 把扫码页操作转成一次内部请求，交给原来的路由；`/shops/:shopCode/player/action` 也同样把店铺页与账号面板的操作转给原来的玩家计费与兑换路由：

| action | 路由 |
| --- | --- |
| `entry` | `POST /api/v1/shops/:code/player/session/start` |
| `card.swipe` | `POST /api/v1/machines/login` |
| `checkout.confirm` | `POST /api/v1/shops/:code/player/checkout/confirm` |
| `redeem.submit` | `POST /api/v1/shops/:code/player/redeem` |
| `page.refresh` | 重新读取当前 `view` |
| 其他扫码操作 | `POST /api/v1/devices/session/actions` |

这样挂在旧路由上的东西都不会漏：`operationId` 防重复、限流、实时活动、闲置倒计时、位置校验。玩家能做什么也和直接调旧路由完全一样。

所有操作用同一个 `operationId` 重发都是安全的，只会执行一次并拿到第一次的回答。还在执行时重发，`notices` 里是 `OPERATION_PENDING`，隔一会儿再问。旧客户端刷卡不带 `operationId`，行为不变。

## 开销

测试数据下，确认页 16 次查询（含首次有效访问写入 `resource.visited`），同票据再次读取的可操作页 13 次（`test/resource-page.test.ts` 里有上限）。比 `/session/state` 多的是 IO 是否在线、投币上限和「有没有在计费」，省下的是客户端原本要单独请求的 `/player/me`；同时把店铺是否计费并入同一条 SQL 查询以生成 `accountMenu`。

设备没有 Home Assistant 连接在线时，读页面会当场问 Home Assistant，每项最多等 3 秒。问不到就当状态未知，不挡玩家操作。

## 旧接口

`/session/state`、`/session/bootstrap`、`/session/device`、`/session/actions` 与旧 `/shops/:shopCode/player/*`（`me`、`billing-inputs`、`assets`、`checkouts/*`、`checkout/*`、`redeem`）全部保留，已发布的 App Clip 继续用它们。
