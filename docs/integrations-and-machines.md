# 外部入口与机器软件接入指南

PRiSM Next 的 API 服务是店铺经营数据的唯一事实源。聊天机器人、自助入场页、扫码入口这类面向玩家的系统统称为 Integration；投币、Aime、门禁、电源、空调等机器侧软件统称为 Machine。两者都通过 Staff Web 生成的接入密钥访问后端，但权限和 API 边界不同。

---

## 1. Integration：机器人与店内入口

Integration 适合 Koishi、AstrBot、自助 Web 入场页、扫码入口等“代表玩家发起业务动作”的系统。它不再需要共享 Player Token，也不需要先调用 Staff API 查询玩家 ID；调用方只需要提交外部身份，后端会负责查找或注册玩家。

**为什么要绑定 Bot 身份。** 绑定让店家知道每位玩家在该平台的身份（例如 QQ 号），玩家有迹可循；在 Koishi 里把绑定命令限制在店铺群内，就只有入群的玩家能完成绑定、进店。

**Bot 向玩家开放哪些命令，在 Bot 端配置。** Koishi 插件的 `playerCommands` 默认 `all`；设为 `readonly` 后，玩家只能绑定（`bind`）、查询（余额、账单、记录、资产、查人、设备状态）和兑换（`redeem`），入场、结账、上下桌和设备操作只有 `staffUserIds` 中的管理员能用（包括替其他玩家操作），玩家会收到 `readOnlyNotice`。后台不做这层限制，因为它分不清请求来自管理员还是玩家。

绑定确认不要求店铺启用计费。「设置 → 玩家与身份 → 绑定提示」可编辑玩家看到的**绑定提示**（`settings.botContact`，含 `{code}` 的一行显示为可复制命令，并有实时预览），用来写明去哪个群、发什么命令，取代固定的「向店铺 Bot 发送 bind 绑定码」（插件命令为 `bind`，旧的 `prism.bind` 保留为同义命令）。Bot 请求里的 `autoRegister` 一律被店铺设置覆盖。

**Token 要求：**

- 在「资源」页添加一个带「店铺 Bot」能力的资源，保存时签发 Bot 接入凭据（只显示一次，连同 API 地址；凭据自己指明店铺，界面上不再显示店铺编号）。「店铺 Bot」一项里显示凭据是否已签发，按钮与 HINATA IO 直连的「签发/轮换设备令牌」同一套：签发或轮换只换凭据，不新建 Bot 资源，旧凭据立即失效。**轮换要三次确认**（见下）——它立即吊销正在用的旧凭据，机器人会断线。设置里不再有「Bot 与接入」分组。
- 请求 Header 使用 `Authorization: Bearer <integration-token>`。
- 不需要 `X-PRiSM-Player-Id`。

### 外部身份

推荐使用结构化身份：

```json
{
  "identity": {
    "provider": "onebot",
    "subject": "123456"
  }
}
```

也可以使用迁移兼容简写：

```json
{
  "identityKey": "onebot:123456"
}
```

`provider` 会统一转成小写，`subject` 只去掉首尾空白。简写只按第一个冒号分隔，所以 `telegram:abc:def` 会解析为 provider `telegram`、subject `abc:def`。

### Bot 的 WebSocket 连接

Koishi 插件（0.2 起）只用一条 WebSocket 和平台通信，不再发 HTTP 请求；HTTP 接口原样保留给旧插件和其它集成。

- 连接：`GET /integration/ws`，一个固定路径，和机台的 `/io/ws` 一样：`Authorization: Bearer <Bot 凭据>`，凭据在握手前解析出店铺，地址里不出现店铺编号或 Bot 标识。凭据不对返回 403，请求不会到店铺的 Hub；不要求店铺启用计费（每个请求仍按自己的路由校验）。旧地址 `/api/v1/shops/:shop/integration/ws` 仍可连接。连接交给店铺 Hub（`ShopHub`），连进来的 WebSocket 可以休眠。部署时 `wrangler.jsonc` 的 `assets.run_worker_first` 必须包含 `/integration/*`（以及 `/rpc*`、`/health*`、`/version*` 等 Worker 自己处理的路径，与 `isAssetEligiblePath` 一致）：否则静态资源的单页应用回退会先接住握手，返回网页 `index.html`，插件报 `Unexpected server response: 200`。`platform-routes.test.ts` 检查两者一致。
- 设备动作失败时，Bot 只告诉玩家关于设备本身、他能理解的事：没有这个设备、设备未连接、设备已关机、设备没有响应。其余原因（配置、通信细节、TTLock 错误码等）只写日志，回复「操作没有完成，请找店员」。超时（请求发出去但没等到应答）按「设备没有响应」处理，不再只有「请稍后再试」。`action.status` 为 `pending`（未确认）时也带 `payload.executorFailure.message`，但仅供 Bot 判断，不直接展示。
- 请求：`{"type":"request","id":"<唯一 ID>","method":"GET|POST|PUT","path":"integration/players/by-identity/wallet","query":{},"body":{}}`；回复 `{"type":"response","id":…,"status":200,"body":{"data":…}}`，`body` 与 HTTP 响应完全相同（含 `{error:{code,message}}`）。Hub 带着 Bot 凭据在进程内调用同一套路由，所以鉴权、校验、灵动岛推送（`waitUntil`）都和 HTTP 一样；吊销凭据后下一个请求就会 403，Hub 随即以 4003 关闭连接。只能访问本店的 `integration/…` 和 `version`，其它路径（包括 `..`）返回 404。
- 去重：写请求（POST/PUT）的回复按 `id` 保存 10 分钟；同一 `id` 再发一次直接返回保存的回复，不会重复执行；还在执行中的同一 `id` 不再执行。断线后插件不重发、不排队，命令直接失败（「暂时连不上服务器」），避免结账、加钱被重复执行或延后执行。
- 心跳：发送文本 `ping`，回复 `pong`（Workers 上由运行时自动回复，不唤醒 Hub）。
- `{"type":"hello","reminderLeadSeconds":300}`：插件告诉 Hub 闲置关机前多久提醒。之后 Hub 推送 `{"type":"event","event":"idle.reminder","data":{"reason":"shop_empty"|"device_idle","at":<关机时间 ms>,"devices":[{"id","name"}]}}`；Koishi 发到 Bot 设置的播报群。多个 Bot 连接时取最长的提前量。只有开了「设备闲置」播报、设置了播报群且提前量大于 0 时才声明。
- `{"type":"event","event":"shop.event","data":…}`：店内动态，Hub 发给所有在线 Bot，每个 Bot 按自己的设置决定播不播（`resources/shop-events.ts`）。四种：`power`（HA 监听器上报的实际开关机变化，由平台确认、保存后分发，`by: "ha"`、`player: null`）、`card`（卡到达机台，`started` 表示这张卡同时让持卡人开始占用机台，即上机）、`coin`（通过平台投币，`started` 同上）、`occupancy`（不经刷卡或投币的上机）。都带 `resourceId`、`resourceName`、`player`（`playerId`、`displayName`、`identities`，认不出的卡为 `null`）。一次刷卡只发一条 `card`，一次投币只发一条 `coin`，上机合并在 `started` 里；平台下发的卡在下发时发出，机台随后回报的同一张卡不再发；Bot 自己的刷卡、投币命令带 `botId`，这个 Bot 已经回复过命令，不再播报。插件：开了「上机」时 `started` 的刷卡或投币按上机播报，否则按刷卡／投币播报。下机（占用超时）是在读取时才结算的，不会实时播报。
- 电源播报覆盖机台电源和空调，覆盖平台操作、HA 手动开关和自动化、闲置自动关机；平台命令成功只代表请求被接受，不触发播报，必须由有完整快照的当前监听器报告明确的开／关增量变化：电源是 `on ↔ off`，空调是 `off ↔ 运行模式`（制冷、制热、送风等）。空调切换运行模式、调温、风速和室温变化不重复发开关播报。平台复用已保存的 HA 状态比较与时间戳去重，多监听器并发、重复／旧事件和仅属性变化只处理一次；首次连接、重连及任务切换的全量快照只同步状态，不补报断线期间的变化，`unknown`／`unavailable` 及恢复也不播报。共享同一 HA 连接与电源或空调实体的资源合并一条（`resourceId` 为首个资源，`resourceName` 为资源名以「、」连接），不再推断操作者或闲置原因，也不附 `botId`，发起开关机的 Bot 同样收到实际变化通知。没有 HA 监听器或没有实际状态变化时不播报；离线 Bot 不缓存补发。
- Koishi 插件保持 0.4.0，撤回的本地 HA 电源播报与 `powerResources` 配置映射不再引入。新后端沿用现有 `shop.event` 格式，0.4.0 将 `by: "ha"` 显示为普通「已开机／已关机」，无需升级插件；发送仍使用该版本的 Koishi 广播接口，不包含 0.4.2 的发送接口修复。

### Bot 是一种资源：设置由服务端下发

每个机器人对应一个带 `bot` 能力的资源，在商户工作台「资源」页添加和编辑（见[资源与资源组](resources.md)）。添加时签发它的接入凭据（只显示一次），删除资源、关闭 Bot 能力或「重新签发」都会吊销旧凭据，旧连接随之断开。凭据与 Bot 资源一一对应：新建店铺时勾选「创建 Bot 接入凭据」会同时建好它的 Bot 资源（默认资源组）；迁移会把旧版遗留的接入凭据一并迁成 Bot 资源（`0043_legacy_bot_resources.sql`），正在运行的 Bot 不会因此断线。Bot 资源不能被玩家扫码。

资源页像 HINATA IO 一样显示 Bot 在线、离线或连接未知，每 15 秒刷新，也可手动刷新设备状态。`botOnline` 来自 ShopHub 当前的 WebSocket，按有效凭据对应到已启用的 Bot 资源；不以 HA 监听席位或历史使用时间代替在线状态，Hub 无法查询时显示未知。旧版遗留且仍保持连接的 Bot 会在读取状态时补齐凭据使用记录，无需重启 Bot。

插件本地只需要 API 地址和接入凭据：凭据自己指明店铺，插件直接连 `/integration/ws`，连上后从 `integration/bot` 读到店铺编号，用于构造网页链接。旧配置里的店铺编号仍被接受，但不再需要。其余都由 `GET integration/bot` 下发：

| 字段 | 来源 |
| --- | --- |
| `bot` | 资源 ID 与名称（名称也用于 Home Assistant 监听名单） |
| `settings` | 在 Bot 资源上设置：玩家命令全部/只读及提示、店员命令、关机仅限店员、结账回执发给店员、入场后自动获取门锁密码（`doorPasswordOnEntry`，默认关；开着且有门锁时 `login`／`入场` 成功后顺带回复 3 分钟临时密码，门锁失败不影响入场）、播报与提醒（`announceChannelIds` 一处频道，`idleReminderMinutes` 提前分钟数，以及 `announceIdle`、`announcePower`、`announceStarts`、`announceCards`、`announceCoins` 五个开关） |
| `staff` | 自动推导：店铺负责人和在职员工的账号绑定的平台身份 `{provider, subject}` |
| `currencyName` | 自动推导：店铺余额资产的名称 |
| `door` | 资源上选择的门锁；没选时若店里只有一个门锁就用它 |
| `mahjongTables` | 自动推导：带麻将能力的资源，含名称、别名和开桌人数（即资源的容量） |
| `billingEnabled` | 自动推导：通过这个 Bot 入场是否计费，即 Bot 资源有专属方案或所在资源组有方案。沿用旧的整店开关字段名，供已发布的插件读取；店铺本身已没有计费开关 |

机器人连上 WebSocket 后先读取这份配置，再发送 hello（名称和闲置提醒提前量取自配置）。**监听 Home Assistant 不是店家的开关**：能连上 Home Assistant 的 Bot 一律在 hello 里声明，由平台按店铺的监听名额自己挑谁在听、听哪些连接；换人、断线、停用都由平台调度，店家不用管。商家保存任何资源、修改资源组（含默认资源组）的计费方案、快速创建计费、导入店铺数据，以及员工通过机器人绑定平台身份后，Hub 会向所有在线机器人推送 `{"type":"config.changed"}`，机器人重新读取并再发一次 hello；不再允许监听时，它正在监听的 Home Assistant 会交给下一个监听者。Bot 资源被停用时该接口返回 `403 BOT_DISABLED`。

Bot 和其他资源一样属于一个资源组，也可以设置专属方案（资源编辑页的「计费」一节）。玩家通过它 `/login`、`/入场` 时，开始的就是这个 Bot 的方案，规则与扫码一样：专属方案优先，否则用所属资源组的方案。没有改过的 Bot 在默认资源组，开始默认资源组的方案。一家店可以有多个 Bot，例如麻将群的 Bot 放在麻将区，入场就开始麻将区的方案。Bot 所在资源组的方案只决定入场；Bot 替玩家操作其他资源时，检查的仍是目标资源的方案。Bot 所在资源组没有方案、Bot 也没有专属方案时，Bot 资源免费，`/login`、`/入场` 返回 `409 RESOURCE_NOT_BILLED`（插件提示「这里不计费，无需入场」）。配置里的 `billingEnabled` 只描述这个 Bot 自己。新版插件只用它拦截 `login`／`入场`：为 `false` 时不请求平台，直接回复「这里不计费，无需入场」；钱包、账单、结账、兑换、上下桌、`list` 等命令属于玩家或各自的资源，一律交给平台判断。旧版插件（0.3.1 及以前）用它拦截所有计费类命令，Bot 在免费资源组时这些命令都会回复「本店未启用计费」，升级插件后恢复正常。方案变化后平台会推送 `config.changed`，Bot 重新读取，缓存的值不会过期。

### 按外部身份上下麻将桌

- `POST integration/players/by-identity/mahjong`，`{identity, table, action: "join" | "leave"}`。`table` 可以是麻将桌资源的 ID、名称或别名。上桌即玩家本人的确认：服务端会开始这张桌资源的计费方案（以及它依赖的方案），满桌时为所有人开台；不需要先入场。返回 `{mahjong: {capacity, seats}}`。错误：`MAHJONG_TABLE_NOT_FOUND`、`MAHJONG_TABLE_FULL`、`MAHJONG_ALREADY_SEATED`。
- `GET integration/mahjong-tables`：每张桌的座位 `{playerId, name, playing}`，供机器人列名单和不带桌名的下桌。
- 下桌只结束座位当前所在的 session（已开局为麻将方案，等位中为麻将桌自己的等位方案），响应带 `billing.remaining`：还在计费的方案名，机器人回复「仍在计费：…」。见 [卡片、占用与查人](occupancy.md#3-麻将等位)。
- `GET integration/roster` 列出在店的人：每人只列一处，正在占用的资源（麻将桌和其他游戏机一样，带人数/容量）或最具体的方案；`?name=` 只列一个资源或一个方案。机器人的 `list` 按它输出，不再自己拼麻将桌。`POST integration/players/by-identity/presence` 回答一位玩家是否在店、计费哪些方案、占用哪些资源。`GET integration/sessions/active` 的每条 session 带 `pricingConfigId` 与 `planName`。

### 常用玩家动作

### 在场客流与设备状态

机器人对自己投资的入口可以读取「在场玩家」和店内设备上报：

| 路由 | 用途 |
| --- | --- |
| `GET /rpc/integration/roster` | 在店的人，每人只列一处（见上文）。每位成员带 `displayName` 与 `identities` (provider+subject)；认不出主人的刷卡不产生占用，不会出现在这里。机器人在 `/list` 里用 `identities` 中的 `subject`（平台用户 ID）去调用聊天平台 API 拉昵称，而不是直接显示后台存的 `displayName`。 |
| `GET /rpc/integration/sessions/active` | 列出在场所有活跃 session，含 `playerDisplayName`、`identities`、`startedAt`、`label`、`elapsedMinutes`、`pricingConfigId`、`planName`。 |
| `GET /rpc/integration/device-states` | 列出每台已启用、绑定了电源的设备的电源状态。设备所在的 HA 连接处于事件驱动时读存储的事实，**不去问 Home Assistant**；无状态时才现场读取 Home Assistant 且不记录（电源可能在平台外被改动，所以这时每次请求都会现查，会变慢）。`state` 为 `on`/`off`；读不到时 `status` 为 `offline`、`state` 为 `unknown`（无状态时存储里残留的旧值是历史，不是当前状态，不再拿来顶替）。`metadata.aliases` 为设备别名。bot 的 `/show` 直接消费。（插件原来的无人自动关机 `powerOffInterval` 已删除，改为后台的「闲置自动关机」。） |

平台昵称的取法因适配器而异：Koishi 走 `session.bot.getUser(qq)`，AstrBot 在 aiocqhttp 走 `bot.call_action("get_stranger_info", user_id=qq)`，telegram、微信、Aime 等按对应适配器提供的方法拉取；取不到则退化为后台存的玩家名。机器人不要把后台存的 displayName 直接写进消息，避免不同身份来源的玩家出现 `Player 123` 这种开发者命名。

### 按外部身份的玩家动作

Integration player actions 都在 `/rpc/integration/players/by-identity/*` 下：

| 路由 | 用途 |
| --- | --- |
| `POST /resolve` | 查找已绑定玩家。 |
| `POST /register` | 查找或注册玩家，并绑定外部身份。 |
| `POST /session/start` | 给玩家开启一条计费 session。 |
| `POST /checkout/preview` | 预览玩家当前 session 结算。 |
| `POST /checkout/confirm` | 确认玩家当前 session 结算。 |
| `POST /sessions/:sessionId/stop` | 停止这名玩家名下的某一条 session，不论它由谁开启。 |
| `POST /wallet` | 查看玩家钱包。 |
| `POST /assets` | 查看玩家资产与流水。 |
| `POST /history` | 查看玩家计时记录。 |
| `POST /redeem` | 为玩家兑换礼物码。 |
| `POST /device-actions` | 按玩家外部身份申请设备动作，例如投币或 Aime 扫卡。 |

示例：平台用户第一次发送 `/入场`，不存在就自动注册，并开始这个 Bot 的计费方案：

```bash
curl -X POST https://prism.example.com/rpc/integration/players/by-identity/session/start \
  -H "Authorization: Bearer <integration-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "identityKey": "onebot:123456",
    "autoRegister": true,
    "displayName": "onebot:123456"
  }'
```

开始哪个方案只由发请求的 Bot 资源决定（见上文「Bot 是一种资源」）；请求里的 `pricingConfigId`、`pricingConfigIds`、`label`、`entry` 都会被忽略。麻将由上下桌接口开始和结束计费，不再由机器人另开 session。无论请求里的 `autoRegister` 如何设置，服务端都以店铺是否允许自动注册为准。

机器人、店员后台、前台收银和扫码确认都走同一个开始入口（`resourceBilling.activate`），结果相同；响应的 `billing.stopped` 列出因互斥被结束的方案，机器人在回复里列出。Bot 所在资源组（包括默认资源组）没有方案时返回 `RESOURCE_NOT_BILLED`；所在资源组停用时返回 `RESOURCE_GROUP_DISABLED`。在场就是有进行中的 session，在哪个场由 session 的方案区分：响应带 `created` 与 `planName`，`created: false` 表示这个方案在这次请求之前就在计费（例如已在「普通游玩」中），返回的是原 session。机器人对设备的操作要求该设备的计费方案在玩家这里计费中，否则返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。

如果 `autoRegister` 为 `false` 或未传，而身份没有绑定玩家，接口会返回 `PLAYER_IDENTITY_NOT_FOUND` 和 HTTP 404。

`POST /sessions/:sessionId/stop` 用于结束某一条 session 的计时但不结账。麻将不再由机器人自己开 session，改用下面的上下桌接口，座位和开台都由服务端管理。它会把 session 关闭并标记为待结算，不会扣款；依赖该方案的其他 session 会在同一时间点一并关闭（见[计费状态编排](pricing-sessions.md)）；玩家最终离店时，统一结算会把仍在运行的 session 和已经停止但未结算的 session 一起计算。

授权边界是**玩家**，不是开启渠道：接口校验外部身份对应的玩家与 session 归属，拿一个 Integration Token 停不了别人的 session；但在这名玩家名下，无论 session 是机器人开的、扫码入口开的还是员工在后台开的，都可以停。计费和结账历来不区分开启渠道，停表也一致。session 上的 `metadata.createdBy` 只记录来源供审计，不参与任何鉴权判断。

没有单独的客户端 SDK；集成直接调用 HTTP API。以下示例使用平台原生 `fetch`：

```ts
await fetch("https://prism.example.com/rpc/integration/players/by-identity/session/start", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.PRISM_INTEGRATION_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    identity: { provider: "onebot", subject: "123456" },
    autoRegister: true,
    displayName: "onebot:123456",
  }),
});
```

玩家命令需要操作机器或设施时，也继续使用 Integration Token。后端会先按 平台用户 ID解析玩家，再检查该玩家是否已入场、投币冷却是否满足，最后生成发给机器通道或设施执行器的指令：

Aime 扫卡可以走便利方法：

```ts
await client.requestScanByIdentity(
  {
    provider: "onebot",
    subject: "123456",
  },
  {
    deviceRef: "舞萌左机",
    provider: "aime",
  },
);
```

`coin`、`aime.scan`、`power.on` 和 `power.off` 都要求玩家当前至少有一条正在运行的计费 session。未入场时接口返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。Bot 不接收游戏机内部 ID 或 Aime 卡号：游戏机通过后台配置的 `name` / `aliases` 解析，刷卡用的是玩家在本店最近用过的卡（加密保存在 `player_cards`，见 [卡片、占用与查人](occupancy.md#1-卡片)）；请求指明卡号时只在它属于该玩家时使用。Bot 配置为关机仅管理员可用时，只允许白名单管理员提交 `power.off` 请求，并附加 `staffOverride: true`；`power.on` 仍要求玩家已入场。后端将覆盖请求记录为员工动作。该覆盖只接受 `power.on/off`，不能用于投币、刷卡或其他设施动作。

旧的 `botToken + playerToken + staffToken` 普通命令模式已经废弃。Integration Token 可调用受限的管理员快捷操作接口：按外部身份调整玩家资产（`POST /rpc/integration/players/by-identity/assets/adjustments`）和按指定总价立即结账（`POST /rpc/integration/players/by-identity/checkout/override`）。这两个接口不授予完整 Staff API 权限；机器人仍必须在自身配置中限制可发起该操作的平台管理员。麻将上桌、下桌这类玩家业务命令不需要额外权限。

---

## 2. 设备：能力、动作与事件

一台设备（`machines`）只表示身份：名称、别名、二维码 `public_id`、是否启用。它能做什么由绑定的**能力**决定，每个能力是 `device_capabilities` 的一行：

| 能力 | 配置（`config_json`） | 密钥（`secret_json`，每个值单独加密） | 动作 | 设备回报 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `power` | `connectionId`、`entityId`（`switch.*`/`input_boolean.*`） | —（旧绑定：`binding`，见下文「店铺 Home Assistant 连接」） | `power.on`、`power.off` | — | `power`，外部权威（事件驱动读存储，无状态现查） |
| `climate` | `connectionId`、`entityId`（`climate.*`） | —（同上） | `climate.on`、`climate.off`、`climate.set_mode`、`climate.set_temperature`、`climate.set_fan_mode` | — | `climate`，外部权威（同上） |
| `hinata_io` | `transport`（`external`/`embedded`）、`coinKey`、`coinAfterSwipe`、`channel` | `url`、`password`（仅外部中继） | `aime.scan`、`coin` | `card.state`、`card.consumed`、`led.set`（不存） | `link`，平台权威 |
| `door` | `lockId` | — | `door.open` | — | — |
| `mahjong` | `capacity`、`pricingConfigIds`（最多一个方案） | — | —（上下桌走麻将流程） | — | — |

**空调（`climate`）单列一个能力，不并入电源**：它的状态是模式和温度而不是开/关；用空调不算「玩过」机台（所有空调动作 `countsAsPlay: false`，不会取消入场的免费宽限）；空调关着也不应该挡住机台投币、刷卡（那只看 `power`）。一台设备可以同时带电源和空调（例如包间：灯电源 + 空调）。

- 动作对应 Home Assistant 的 `climate/turn_on`、`turn_off`、`set_hvac_mode`（`mode`）、`set_temperature`（`temperature`）、`set_fan_mode`（`fanMode`）。可选的模式、风速、温度范围和步长不写死，每次从实体的 `hvac_modes`、`fan_modes`、`min_temp`、`max_temp`、`target_temp_step` 读取；实体不接受的值由 Home Assistant 拒绝，操作记为失败。
- 状态读取：看板的整店读取 `GET /api/v1/merchant/machines/states`、玩家页的 `GET /api/v1/devices/session/device`、两者的 WebSocket 帧和动作的响应都带 `climate`（`{ mode, modes, temperature, currentTemperature, minTemperature, maxTemperature, temperatureStep, fanMode, fanModes }`，读不到为 `null`）；玩家页首屏接口 `GET /api/v1/devices/session/bootstrap` 只在设备实时时带（`state.device.climate`）。从哪里读由后端决定（实时读存储，否则现读 HA），客户端不知道也不需要知道。只把**设定**（模式、目标温度、风速）记为 `change` 事件；室温会自己漂移，完整视图另存为不记事件的 `climate/view`。
- 玩家扫码后能做全部空调操作（含关空调）；空调所在资源设置了计费方案时要求先入场，和其它设备动作一样。`power.off` 仍然仅限店员。开启位置校验后，每个空调动作都和机台操作一样要求在店内（`checkShopLocation(…, "machine")`），后台店员操作不校验。
- 玩家页是独立的空调卡片（`PlayerClimate`）：关着时只有「开空调」；开着时中间是大号设定温度和 −/+，下面是带图标的模式分段和风速分段，卡片颜色随模式变化（制冷蓝、制热橙等）。其它按钮实时发送；−/+ 在停下 1 秒后合并成一次 `climate.set_temperature`，连按会重新计时，避免每一步都重新定位、都调用一次 Home Assistant。选择立即显示，以后端说的实际状态为准（动作的响应、Hub 的推送，哪个先到用哪个），6 秒内没有对上就回到实际状态；不论设备是否实时都是同一套逻辑。后台操作面板沿用同一套逻辑，样式更紧凑。
- **「全部开/关机」（`target.ref: "all"` 的 `power.on/off`）同时开/关所有空调**，不同实体各记一条 `climate.on/off` 操作，与电源操作共用一个父操作 ID。多个资源绑定同一 HA 连接和同一实体时，每次全部开／关只下发一次，操作记录归到首个资源；不同 HA 连接上的同名实体分开执行。所有关联资源的权限检查仍在去重之前完成。Bot 的 `off all` 与 Koishi 的无人自动关机都走这条路径，因此也会关空调。
- 保存设备时 `climate` 与电源的 `homeAssistant` 形状相同（见下一节），实体必须是 `climate.*`。

### 店铺 Home Assistant 连接

Home Assistant 的地址和令牌是**店铺级**的：一个 Home Assistant 一条连接，店里所有电源和空调能力都指向其中一条，能力里只存 `connectionId` 和 `entityId`。换令牌或地址只改一处。

- 每条连接是一行 `app_settings`，键为 `devices.ha_connection:<id>`，值为 `{ id, url, internalUrl, token, readToken, readUserId, readAccess, readError, updatedAt }`。`token`（控制用）和 `readToken`（只读）用平台密钥加密；店铺备份下载时解密、导入时用目标环境密钥重新加密，和设备能力的密钥一样。
- 保存设备时 `homeAssistant` / `climate` 二选一：`{ connectionId, entityId }` 直接选连接；或沿用旧形状 `{ url, entityId, token? }`，平台按地址找到或新建连接。令牌留空时依次沿用：这个能力原来的令牌、同一地址的另一个 HA 能力的令牌、店里这个地址已有的连接；都没有返回 `HOME_ASSISTANT_TOKEN_REQUIRED`。同一地址、不同令牌会成为两条连接。
- 旧绑定（url、令牌、实体都在能力密钥 `binding` 里）照常工作，在下次读取店铺设备列表时**自动迁到连接上**：按「地址 + 令牌」生成固定的连接 ID，只在能力行未被改动时改写，所以重复执行或并发执行结果相同；备份正在导出、店铺只读时迁移失败，下次再试。
- 后台接口（店长、管理员；令牌永不返回）：`GET /api/v1/merchant/ha-connections?shopId=` 列出连接与使用它的能力数；`PATCH /ha-connections/:id?shopId=` 改 `url` / `token`；`DELETE` 仅限无设备使用（否则 `HA_CONNECTION_IN_USE`）；`GET /ha-connections/:id/entities?shopId=` 实时读取 HA 的 `switch`、`input_boolean`、`climate` 实体，供设备编辑器选择。

#### 只读账号（实时状态用）

店里负责盯 Home Assistant 的游戏机拿到的令牌**不能开关任何东西**。Home Assistant 没有按实体的权限，但内置用户组 `system-read-only` 只能读、不能控制（调用实体服务时检查控制权限，没有就拒绝）。

- 新建连接后，平台在后台（`waitUntil`）用连接的控制令牌执行：`auth/current_user` 确认是管理员 → `config/auth/create`（`group_ids: ["system-read-only"]`）建用户 → `config/auth_provider/homeassistant/create` 给它随机用户名和密码 → 走 HA 登录流程（`/auth/login_flow` + `/auth/token`，`client_id` 为平台地址）以该用户登录 → 以该用户身份 `auth/long_lived_access_token`（3650 天）→ `config/auth_provider/homeassistant/delete` 删掉它的密码，长期令牌成为这个账号唯一的入口。顺带读 `GET /api/config` 的 `internal_url` 存为 `internalUrl`，供店内机台优先使用。重做时先删除旧的只读用户。
- 控制令牌不是管理员的，`readAccess` 为 `needs_admin`：设备编辑器提示贴一次管理员令牌，`POST /ha-connections/:id/read-access?shopId=`（`{ adminToken? }`）只在这一次请求里使用它，不保存。其它失败记为 `failed` 并带原因，可以重试。本地 Bun 服务端没有 `waitUntil`，只能用这个接口手动触发。
- **旧连接补建**：只读账号只在新建连接、改连接的地址或令牌时自动创建，而功能上线之前存下的连接是第一次读取时由旧绑定「采纳」出来的，`readAccess` 为空，从没有人尝试过，编辑器里会一直显示「正在启用实时状态…」。所以店铺 Hub 在构建监听任务时（IO 上线、设备或连接变化、闹钟补位都会走到），对**有设备在用、`readAccess` 为空**的连接补建一次：用控制令牌走上面的流程，成功后立刻重建监听。补建放在 Hub 里而不是请求里，因为每个店铺只有这一个对象，能看到「已经在跑」，同一条连接同一时间只会跑一次；两次并发会在 HA 里各建一个用户，先建的那个留下仍然有效的令牌。结果是 `needs_admin` 或 `failed` 的不会再自动重试，由编辑器提示原因。没有 IO 在线的店铺不会触发，也就不会在没有人需要实时状态时去动店家的 Home Assistant。
- 依赖 Home Assistant 默认的用户名密码登录方式；店家关掉它时这一步失败，需要手动提供令牌。只读用户仍可调用少数不针对实体的服务（如发通知），但控制不了任何设备。整条流程已在真实 Home Assistant（官方 docker 镜像）上跑过：管理员令牌得到 `ready`，非管理员令牌得到 `needs_admin`，IO 固件用只读令牌订阅事件并收到完整快照；见 [开发环境](dev-environment.md#真实-home-assistant-与-hinata-io-的端到端测试)。

能力目录写在 `packages/server/src/resources/capabilities/catalog.ts`，是唯一的定义处：配置校验、动作是否算作「玩过」（计费宽限用）、哪些回报要存、状态由谁权威，都在这里声明。数据库里没有能力名或事件类型的 CHECK 约束，新增能力不需要改表。

### 动作、副作用与事件

- **动作**是平台向设备提出的请求（意图）。每次动作记为一条 `device_operations`，同时写入一条 `request` 事件；执行后写 `result` 事件并结算为 `succeeded`/`failed`。网络超时等**无法确定结果**的情况保持 `pending`：设备可能已经动作了，计费一直把未结算的请求算作使用。
- **副作用**是现实中发生的事（机器开了、卡进了游戏），平台不能直接观察。
- **事件**是平台记录下来的事实（`device_events`，只增不改）：`request`/`result`（平台发起）、`signal`（设备回报，如 `card.consumed`）、`change`（状态变化，如电源从开到关、机台上线/掉线）。
- 设备回报 `card.consumed` 时，会把对应的 `aime.scan` 操作标记为 `confirmed_at`（只认本设备的操作）。
- 状态（`device_state`）只在值变化时写一条 `change` 事件。电源和空调是**外部权威**：真相在 Home Assistant。一个连接被监听者订阅时（事件驱动），每个事件写入 `device_state`，存储的值就是事实，读者只读存储；没有人监听时（无状态）设备没有已知状态，读者现查 HA 且不记录，存储里残留的旧值被忽略（见「店铺 Hub」）。直连链路 `link` 是**平台权威**，由中继在连接/断开时写入。
- 以后要做「空闲/忙碌」这类派生状态时，应当监听**事件**（包括设备回报和观测到的变化），而不是只看平台发出的动作。

所有写入都经过 `packages/server/src/resources/capabilities/bus.ts`：`perform`（动作）、`signal`（回报）、`setOwned`（平台权威状态）、`reportMany`（监听者上报的外部状态，一批写入，可只存储不记事件）。`observe`（现读后写入）仍在总线上但不再用于任何读取路径。动作不会在完成后读回外部状态。其他代码不直接写设备表。卡号只作为临时参数交给执行器，从不落库；门锁临时密码只在本次响应返回。

### 设备看板与编辑器（Web）

商户后台的资源页按「资源是身份、能力是配置」组织，与服务端能力目录一一对应：

- 设备卡片只陈述三件事：设备身份（名称、别名、启用状态）、已绑定的能力徽章、实时状态（电源、空调模式与温度、直连在线）。**每个带电源或空调的设备有一个「实时 / 非实时」标签**：「实时」表示它用到的 Home Assistant 连接有监听者订阅着并交付了完整状态，「非实时」表示没有。**标签只是显示，看板不按它做任何决定**：何时去问 Home Assistant、值从哪来，都由后端决定。值不会因为旧而变成「未知」：后端还没说的字段显示「读取…」，后端读不到（`null`）才是「未知」；一台设备变成非实时时保留它最后一次的值，直到后端说出新值。门锁、麻将桌这类没有电源和空调的设备没有标签。
- **看板只显示后端告诉它的，自己不读。** 进入资源页后连上店铺 Hub 的一条 WebSocket：连接建立时 Hub 发整店的标签和实时设备的值，随后发它替非实时设备问到的 Home Assistant 结果；之后每次变化（电源开关、空调设定和室温）推过来。哪些设备是实时的发生变化时，Hub 重发整店的标签，并替刚变成非实时的设备问一次 Home Assistant、把结果推过来。对任何设备执行开关机或空调操作，响应里带操作后设备的状态（见下文「动作读回」），看板直接显示；非实时设备的这份结果也由 Hub 推给其它看板和该设备的玩家页。操作后只重载设备列表（名称、绑定等），不读状态。
- **HTTP 读取只有两种用途**：页头店铺级的「刷新设备状态」按钮（一直可用，后端决定每台设备从哪里读），和 Hub 没给出状态时的兜底（连不上或连上后 3 秒内什么都没说时读一次整店；某台设备的值 20 秒后还没跟上标签时也读一次）。HTTP 的回答和推送谁新用谁：一台设备在这次请求发出之后收到过推送，就保留推送的值。连接断开后按 5、10、20、60 秒递增重连，Hub 在重连成功时重发整店，断开期间看板显示断开前的值。「操作」面板的电源和空调直接取看板已有的状态，打开时不读；麻将座位不是 Home Assistant 状态，没有推送，面板用 `GET …/machines/:id/mahjong` 单独读。卡片底部是「操作」（主按钮）、「编辑」、「操作记录」和二维码入口；有可执行能力的设备才显示「操作」，只读账号不显示。
- **下发操作与历史记录是两个入口**：`操作` 打开只含开机/关机/投币/开门密码的确认面板，`操作记录` 打开只读的事件时间线。两者混在一个弹窗里会让有后果的按钮看起来像记录的一部分。
- 编辑器分两段：**设备身份**（名称、别名、启用）和**设备能力**。每项能力是一张带开关的卡片——电源、空调、刷卡（外部中继或直连）、开门密码、麻将桌；关闭的能力不渲染其表单，避免四种凭据同时铺开。提交按钮吸底，长表单无需滚到末尾才能保存。
- 刷卡能力的连接方式里「直连本平台」排在前面，新加的刷卡能力默认直连；已经在用外部中继的资源保持原样。资源页对还在用外部中继的刷卡机台显示横幅，建议改为直连，点机台名直接打开它的编辑器。
- 直连模式（`transport: "embedded"`）的令牌是**显式签发的**：面板里只有「签发设备令牌 / 轮换设备令牌」按钮，普通保存不会顺手创建凭据；未签发就保存会被拒绝并提示先签发或改用外部中继。签发成功后弹窗切换为一次性交付步骤，显示令牌、可复制的两行 INI 片段（`serverUrl=` / `deviceToken=`），在点击「我已写入机台」之前关闭按钮禁用。
- **IO 心跳与「机台在线」**：直连 IO 用设备令牌连上后，**每 60 秒发一条 `io.heartbeat`**，不论它是不是当前的 HA 监听者——「连上了」和「还活着」是两件事，机器断电时进程直接消失，没有 close 帧，socket 会留在 `MachineRelay` 里直到运行时自己发现。平台记录每条连接的最近消息时间（任何消息都算，不只心跳），**连续 150 秒（两个心跳加余量）没有消息就判离线**。IO 是否在线统一由 `MachineRelay` 根据 WebSocket 和最近消息判断；心跳超时 alarm、连接关闭以及面板查询发现离线时，都会同步通知 Hub 删除该 IO 的 HA 任务及候选并补位，不再等待另一份 HA 租约到期。没有人打开面板时 alarm 也会执行；刷新只读连接记录，不向 IO 发 ping。心跳里带 `ha[]`（每条 HA 连接的 `term`、`connection`、`connected`、`error`），所以 HA 健康不再单独发 `ha.status`；`ha.states` 仍单独上报状态。密码连接（E2EE 或旧中继）不发心跳。
- **关机之后的观察**：机台断电时，平台**不知道它的 IO 是不是也断电了**——IO 可能跑在机台里，也可能独立供电。这不是能从平台侧看出来的一件事，所以平台不猜，改成看 IO 实际的表现。
  - 关机时**保留**它已有的订阅和任期，不发 `HA_UNWATCH`，不关任何连接。只把它的报告暂时标为「待确认」：最后一帧快照是断电之前拍的，不能当作此刻的事实。
  - 如果这条 HA 连接没有别的可信订阅者，前后台暂时回到非实时读取，直到该 IO 发来**断电之后**、`connected=true` 的健康心跳为止（触发关机的状态报告、关机前已经排队的心跳都不算）。恢复用的是原来的 WebSocket 和原来的任期，不重新订阅。
  - **待确认的旧任期不占正常名额**，平台立即按店铺配置补齐其它监听者，即使已有历史信用也要等本次心跳。临时补位的机台再关机，继续补下一台，不等前一台的租约到期。配置上限 4 限制正常名额；保留的待确认任务和交接中的旧任务可使总任务数临时超过配置值，旧任务恢复后按优先级收回多余任务，静默任务仍在 150 秒租约到期时清理。
  - 观察窗口 3 分钟：IO 全程照常上报、HA 也确认机台确实关了，就记一次成功，这个 IO 从此算「断电也不死」，同类候选里优先选择；它之后关机仍须用本次心跳确认，恢复后不继续保留额外名额。IO 停止上报、租约最终过期，就记一次失败；连续两次失败撤销信用。关了一半又开机的，算不确定，不加分也不扣分。
  - 同一次关机可能被报两遍（平台的命令一次、HA 的状态变化一次），按**一次**观察处理。
  - **共用电源按整组处理**：相同 Home Assistant 连接与电源实体绑定的资源，不论关机命令针对哪一个、是否自带 IO，先一起暂停采信所有在任监听器，再选择备用。同组待命候选先退出候选名单，收到断电后的无任务心跳或新的 hello 后才能再参与，避免把同一电源下另一台机台当成备用；HA 的 `on → off` 事件同样处理整组。不同连接或不同实体不会合并；未配置的物理接线关系无法推断。
  - 平台**不主动断开** IO 连接：断开也拦不住它重连（客户端把 Close 当普通断线，2 秒起、30 秒封顶退避重连），所以在线与否一律由心跳判定，见上一节。
- 空资源页说明「资源」是店里玩家扫码就能用的东西（机台、门、麻将桌，或没有硬件、只用来开始计费的二维码）；`/merchant/:shop/resources?add=1` 直接打开添加资源弹窗（开店指引使用；旧地址 `/devices` 会跳转过来）。二维码弹窗提供「打印」（新窗口只含二维码和资源名）、带「已复制」反馈的复制链接和测试扫码入口。NFC 入口就是把同一个链接写进标签的 NDEF URI 记录：iPhone 碰一下会唤起 hinata_go 里的 PRiSM Link App Clip（免安装），其它手机用浏览器或 HINATA Go 打开；弹窗下方写明了这一点。
- 编辑器里开门密码能力会检查店铺 TTLock 账号：未连接时红字提示并链接到「设置 → 位置与设备」；麻将桌没有可选计费规则时链接到「计费」页；麻将桌所在资源没有计费方案时不要求选择对局方案，入座免费；外部中继缺连接密码时说明投币为何不可设置。
- 能力判定集中在前端适配层 `packages/prism-web/src/ui/merchant/resource-capabilities.ts`（`resourceCapabilities`、`canOperateCoin`、`deviceActions`、`deviceSummaryKey`）。卡片徽章、操作记录里的可用动作、编辑器里的开关都读这一处，不再各自从 `ttlockLockId`/`homeAssistant`/`hasHinata` 推导。
- 提交仍使用商户 API 的扁平字段（`homeAssistant`、`ttlockLockId`、`mahjong`、`hinataUrl`/`hinataPassword`、`relayConnection`、`coinKey`、`coinAfterSwipe`）；关闭某项能力时发送 `null`（刷卡为 `relayConnection: "external"` + `hinataUrl: null`）让服务端删除对应能力行。适配层只是视图模型，不改变接口契约。

**轮换令牌一律三次确认**（`ResourceEditor` 的 `RotateTokenConfirm`）。签发和轮换是两回事：签发是第一次给凭据，没有旧值可吊销，一次点击即可；**轮换**会立即吊销旧值、让正在用它的 Bot 或机台断线，因此要走三步：

1. 一个说明将要发生什么的按钮，点开才进入确认；
2. 读出后果，勾选「我知道旧令牌取不回来」才能继续；
3. 手打确认词「轮换」，只有打对了表单真正的提交按钮才会出现在页面里。

三步走完之前 DOM 里没有提交按钮，所以误点或回车都到不了服务端。后台的两处轮换——Bot 接入凭据和直连设备令牌——都走这套；`scripts/check-rotate-token-browser.cjs` 在 CI 里守住这条线：最后一步之前不发任何 PATCH，确认词不对时真实按钮不存在。

### 「操作」面板

- `GET /api/v1/merchant/machines` 的每台设备带 `actions`：能力目录里当前可用的动作，形如 `{ name: "power.on", capability: "power" }`。后台「操作」面板按 `capability` 分组渲染（电源控制 / 刷卡·HINATA IO / 开门密码 / 麻将桌），**新增能力不需要改前端**；前端只在接口没有 `actions` 时退回本地推导。
- 空调分组（`ClimateControls`，与玩家扫码页共用）：开/关空调，以及按实体上报的模式、温度加减（按步长、限制在最低/最高温度之间）和风速，单击即下发；标题右侧显示「模式 · 设定温度 · 室温」。
- 每个分组标题右侧显示与该组操作相关的状态：电源为实时 `power`（已开机/已关机/未知），直连刷卡为链路在线状态（外部中继则显示连接方式），门锁显示 `lockId`，麻将桌显示 `已入座 / 容量`。
- 麻将上桌的候选人来自 `staff/live-players`（已入场在店玩家），已入座的人不重复出现；上桌要求该玩家有进行中的入场，所以全量玩家列表里大多数人本来就会失败。
- 刷卡由店员直接输入 **20 位卡号**（`cardNumber`）发送；也可以传 `playerId`，平台解密该玩家在本店最近用过的卡，这次操作同时记为该玩家占用这台机台。卡号只作为临时参数交给执行器，不落库；卡号格式不合法返回 400，玩家没有绑定卡返回 `SCAN_IDENTITY_NOT_BOUND_TO_PLAYER`。
- `mahjong.seat` / `mahjong.unseat` 接受 `playerId`，让所选玩家上桌/下桌。上桌与玩家自身上桌走同一套校验：玩家必须启用、计费开启时必须有进行中的入场（`CHECKIN_REQUIRED`），麻将计费规则必须齐全且处于可计费时段。店员操作不校验店员自身定位，但玩家资格、封禁与牌桌容量照常校验。
- `GET /api/v1/merchant/machines/:id/mahjong` 返回 `{ mahjong }`；`mahjong` 为 `{ capacity, seats: [{ playerId, name, playing }] }`，供操作面板显示座位并选择下桌对象。没有麻将能力的设备返回 `null`。电源和空调的状态是另一个接口 `…/:id/state`，见「读取的接口」。

- 投币可以在操作面板现场指定要按的键（`key`）：字母、数字、空格、Enter、常用未加 Shift 的符号都支持；不传则使用设备配置的 `coinKey`。服务端把字符映射成 Windows Virtual-Key 码，协议本身只传数字键码，带 Shift 的符号（如 `!`）无法表示。只有店员可以指定按键，玩家端仍使用设备配置。

### 引用设备与 Bot 动作

Bot、员工和 integration API 用 `target.ref` 引用设备，匹配设备 ID、`public_id`、名称或任一别名（不区分大小写、去首尾空白）；多台同名返回 `DEVICE_REFERENCE_AMBIGUOUS`。`all` 只用于 `power.on/off`，作用于所有已启用且绑定电源的设备，每台一条操作，共用同一个父操作 ID。玩家发起 `coin`、`aime.scan`、`power.*` 需要处于活跃计费场次；投币受店铺 `venue.operations.coinCooldownMs` 冷却限制。返回体保持旧的 `DeviceCommand` 形状（`status` 为 `acked`/`pending`/`expired`，`executorKind`、`payload.deviceLabel`、`payload.executorFailure`、门锁的 `temporaryPassword`），Bot 与员工视图无需改动。

### 旧版设备注册表

早期部署把 HA、HINATA IO、TTLock 设备存在店铺设置（`devices.homeassistant` + `devices.homeassistant_connection`、`devices.hinata_io`、`devices.ttlock`）。读取设备列表时（设备看板、Bot 动作、设备状态），这些条目会**自动转成正式设备**：固定 ID `legacy:ha|io|lock:<店铺>:<原 id>`，原 id（HA 实体等）加入别名以保持 Bot 指令可用，旧操作记录里以原 id 或名称记录的设备改指向新设备，然后删除注册表（`devices.homeassistant_connection` 与 `devices.ttlock_connection` 保留）。转换需要平台加密密钥，未配置 `URL_ENCRYPTION_KEY` 时保持原样等待下次。原来的 `scripts/import-legacy-devices.ts` 因此删除。

### TTLock

TTLock 账号是店铺级的，保存在 `app_settings` 的 `devices.ttlock_connection`（字段兼容旧 `prism-neo`：`baseUrl`、`clientId`、`clientSecret`、`appAccount`、`appPwd`、`accessToken`、`refreshToken`、`accessTokenExpiresAt`）。设备上绑定 `door` 能力并填写 `lockId`。`door.open` 调用 `/v3/keyboardPwd/add` 创建 8 位随机临时密码，有效期 3 分钟；access token 过期时先用 `refreshToken`，失败后用账号密码重新获取，并把新 token 写回设置。

### HINATA IO：外部中继

`transport: "external"` 时平台通过 HTTP 访问外部 relay（`secret.url`）。有连接密码时按 Hinata IO 协议用 PBKDF2-HMAC-SHA256 与 AES-256-GCM 生成 `E2EE_V1`：投币向 `<url>/event` 发送有效期 30 秒、带去重 ID 的 `KEY_PRESS`；刷卡向 `<url>` 发送一次性 `SET_CARD`。投币必须有密码，按键码 1–65535。relay 的 HTTP 拒绝记为失败（状态码写入结果事件和登录审计），无响应记为结果未知。外部 relay 的「已接收」不等于机台真正读到了卡。

### HINATA IO：机台直连（内嵌中继）

`transport: "embedded"` 时机台直接连本平台：`[aimeio] serverUrl=<APP_ORIGIN>/io/ws`，再填写平台签发的 `deviceToken`。

- 保存时生成 `prism_io_` 前缀的随机令牌，**只在保存响应里返回一次**，库里只存 SHA-256（`device_capabilities.credential_hash`）。`rotateRelayToken: true` 轮换令牌；通道名 `config.channel` 与令牌无关，轮换不会断开在线机台。
- WebSocket 升级请求带 `Authorization: Bearer <deviceToken>`，平台在握手前按令牌找到设备和通道；令牌无效返回 401，机台客户端把 401/403 当作永久失败停止重连。
- 直连不做端到端加密：平台既是中继也是控制端，卡号本来就由平台从 `cards.access_code` 取出，身份由设备令牌承担，机密性由 `wss://` 承担。保存为直连时会丢弃之前给外部中继存的密码；请求里同时提交密码返回 `DEVICE_RELAY_PASSWORD_CONFLICT`。机台若仍设置了 `remotePassword`，会在 `CLIENT_HELLO` 里声明 `e2ee: true`，平台拒绝下发并在设备看板提示清空。
- 通道是 `MachineRelay` Durable Object（binding `MACHINE_RELAY`，迁移 tag `machine-relay-v1`）。控制端接口不对外暴露，`/io/ws` 是唯一公开路径。设备看板上的「已连接」直接问 Durable Object，不读存储：部署重启会断开连接却不触发断开回调。
- 机台通过同一连接回报 `event.cardStateChanged`、`event.cardConsumed`、`event.ledSet`，分别记为 `card.state`、`card.consumed` 信号；`led.set` 每帧都有，不存储。下发刷卡时平台把操作 ID 放进 `source`，机台原样回传；只有 UUID 形式的 `source` 被当作关联，`Remote`、`HINATA(<实例>)` 等机台本地来源不关联任何操作。卡片事件带着卡号（包括玩家直接在读卡器上刷的实体卡）：平台用它认出卡主人、记在事件的 `player_id` 上，并推断谁在占用机台，存入日志前去掉卡号，只留卡类型。
- 机台断线重连时，平台只重发**仍在有效期内、且还没被游戏取走**的那张卡（客户端默认 3 秒后丢弃远程卡）。游戏取走后（`source` 一致的 `card.consumed`）或过了有效期，存着的卡就被删除；旧版本存下的、没有有效期的卡一律不重发。否则机台几小时后重启，会把上一位玩家的卡再塞进游戏。

#### 扫码刷卡的结果

玩家在扫码页刷卡（`POST /api/v1/machines/login`）时，直连机台会等到游戏取走卡再返回，**不等读卡器灯光**：

1. 发卡前先在 `MachineRelay` 内存里登记等待，再下发 `SET_CARD`；等待期间请求未返回，对象不会休眠。
2. 约 4.5 秒内收到 `source` 一致的 `event.cardConsumed` 就是 `read`（游戏拿到了卡），立即返回；收不到就是 `not_read`（游戏不在读卡，卡已作废）。
3. 新卡会顶掉机台上还没被取走的旧卡，旧卡的等待随即以 `not_read` 结束。

游戏服务器是否接受了这张卡不再判断：以前要再等最多 15 秒读卡器的结果灯（`event.ledSet`），等待期间操作一直显示「结果待确认」，现在 `event.ledSet` 一律忽略、不再记 `card.login`。设备日志里以前记下的 `card.login` 照常显示。

**操作编号与重试**：网页的写操作带 UUID `operationId`，响应丢失时用原编号重试，服务器重放保存的结果、不会重复执行（`runPlayerOperation`）。设备操作（后台 `POST /api/v1/merchant/machines/:id/actions`、扫码页 `POST /api/v1/devices/session/actions`）放宽了两点：服务器只要给了回答（包括设备失败的 502），编号就作废，下次是新请求，否则用原编号重试只会一直重放那次失败；没收到回答时编号保留，但换一个操作或换一张卡会直接作为新请求发出，不再提示「上一笔操作尚未确认」。没确认的那一笔仍留在设备日志里。结账、充值等扣款操作不变：没收到回答时，换参数的请求仍会被拦下。

响应的 `card` 字段：`read`、`not_read`；外部中继收不到任何回报，记为 `sent`。旧客户端忽略这个字段。开启「刷卡后自动投币」时，`not_read` 不投币，`coin` 返回 `skipped`，`reason` 为 `CARD_NOT_READ`。扫码页在卡片行的说明文字里显示「已刷卡」或「登录失败」（`not_read`），投币结果接在后面（如「已刷卡 · 已投币」）；结果停留几秒，期间其它卡片和投币按钮照常可用。

### 店铺 Hub：谁替店里盯着 Home Assistant，以及设备状态的两种模式

每家店有一个 `ShopHub` Durable Object（binding `SHOP_HUB`，迁移 tag `shop-hub-v1`，名字是店铺 ID），它从店里**在线的 Bot 和直连 HINATA IO 中挑最多两个**（默认两个，平台管理员可按店铺调整，见下），让它们用只读令牌订阅 Home Assistant（`subscribe_entities`），把状态变化经已有的连接报回来。HA 不必暴露到公网（监听者在局域网里也行），机台连进来的 WebSocket 照常可以休眠。Bot 的 WebSocket、玩家资源页和商户看板的 WebSocket 都进这个对象；只有机台直连走每台一个的 `MachineRelay`。

#### 两种模式（按 Home Assistant 连接）

- **事件驱动**：一个 HA 连接被至少一台存活的监听者订阅着、并且那台已经交付了完整状态时，`ha_event_connections` 里有它的一行。此时 `device_state` 就是**事实**：玩家页的首屏接口、后台设备看板、Bot 的 `device-states`、投币前的电源检查都直接读 D1，**不再去问 Home Assistant**，也就不需要信任或过期的判断。
- **无状态**：其余情况下设备没有已知状态。需要状态的读者自己现查 Home Assistant，**不写入任何状态或事件**；只有平台自己发起的动作（开关机、空调）会写 `request`/`result` 事件。闲置自动关机不依赖设备的实际状态，所以不受影响（见下）。后台设备看板给这样的设备打「非实时」标签；它的值由后端替客户端去问 HA（Hub 发给看板和玩家页时、动作读回时、刷新时），客户端不自己决定，见下。

连接进入事件驱动要同时满足：监听者的租约有效（150 秒内有上报：两次 60 秒心跳加余量）、它对这个连接最近一次 `ha.status` 是已连接、当前这一任期已交付该连接的全量状态。**先把状态写进 D1，再把连接宣布为事件驱动**；任何一条不满足就回到无状态。只有 ShopHub 判定模式，`ha_event_connections` 只在切换时写。模式变化时 Hub 把设备的当前状态推给相关的玩家资源页（`watching` 帧）：变成事件驱动时带存储的值，退出时替页面问一次 HA 再带上。**只有开着页面或看板的设备才会被问**：没人看时，连接进出实时都不碰 HA。同一台设备被几个页面和看板同时需要时只问一次：Hub 里同一设备的 HA 读取进行中或刚答完（2 秒内）就共用这一份；实时设备的读取不共用（它的存储值随每次上报变化），实时集合一变就全部作废，动作读回（`deviceRead`）也会作废那台设备的共用读取。Hub 把 HA 的回答发给页面或看板之前会再确认那台设备仍不是实时：问的期间它变成了实时，就丢弃这份回答，免得它把「实时」标签和更新的值改回去。`watching` 字段是设备用到的所有连接都处于事件驱动，**只留给还自己判断模式的旧版 App Clip**；网页客户端不读它（看板上它只是「实时 / 非实时」标签）。值为 `null` 表示读不到或 HA 报告不可用（`unavailable`/`unknown`），不当作开也不当作关。

**读取只有一个入口**：`packages/server/src/resources/capabilities/device-state.ts`。除 ShopHub（它写这两张表）外，没有别的代码为电源或空调去读 `device_state` 或 `ha_event_connections`。读者分两种：

- **要答案的**：`readDeviceState`（单台）、`readShopDeviceStates`（整店或给定的一组设备）、只要一项时的 `readPower` / `readClimate`。实时设备读存储，其余当场问 Home Assistant（整店读取时并发上限 4），不记录。玩家页 `/session/device` 与 WebSocket 帧、看板 `/machines/states` 与 Hub 替看板问的非实时设备、`readAfterAction` 的动作读回、Bot 的 `device-states`、投币与刷卡前的电源检查、`power.keep` 都走这里。
- **只能读存储、不能碰 HA 的**：`readLiveState`（单台）、`readShopLiveStates`（一组设备）。非实时设备返回 `{ watching: false, power: null, climate: null }`（`unknownState`）。看板连接时的第一份快照、玩家页首屏里的 `device`（首屏不等 HA）、闲置自动关机用这一种；闲置检查直接传入 Hub 自己持有的实时连接集合，不再查表。

客户端拿到的永远是 `DeviceView`：只有设备具备的 `power` / `climate`，没有「从哪来」。没说的键是「还没说」，`null` 是「读不到」。

是否实时只有一条规则：设备的电源和空调用到的**每一条**连接都在实时集合里。闲置检查也按这条规则判断，所以看板显示「非实时」的设备，闲置规则同样把它的电源当未知。

#### 监听者

- **谁能被选**：`CLIENT_HELLO` 的 `body.features` 含 `ha.watch` 的机台。`MachineRelay` 收到这样的 hello 就告诉 Hub 自己上线（`relayOnline`），连接关闭或心跳判离线时告诉 Hub 下线（`relayOffline`）。每个 WebSocket 有独立的会话标识，部署后即使机台、通道名不变，新会话也会重新下发任务，并且只发到该会话；旧会话迟到的心跳和状态不会抢回任务。健康心跳保持原任期；`ha[]` 为空表示 IO 没有任务，Hub 会重新分配，不必等 150 秒超时。网关把通道名放在 `x-prism-relay-channel` 头里交给 `MachineRelay`，Hub 用它回头找到这台机台。
- **选谁**：名额是这家店的监听器数量（默认 2，平台管理员可改，见下）。**Bot 优先于机台**：一个 Bot 在线就占一个名额，两个 Bot 就占满，机台只补空位；同类里在线最久的优先；刚失败过的（连不上 HA、没能下发、租约过期）5 分钟内排在后面，不论是 Bot 还是机台，所以一个连不上 HA 的 Bot 不会把名额一直占着。两个监听者同时报同一个事件，谁先到谁生效，另一份按下面的去重丢弃，不分高低。第二个名额的作用是**不让状态断流**：一个掉线时另一个仍在报，模式不会闪回无状态，空出来的位置由下一个在线的候选补上。令牌只在监听者的内存里。
- **让位没有空窗**：Bot 上线或名额调小，会让原来在监听的机台被「挤出去」。被挤的监听者要等**留下的监听者对每条已宣布为事件驱动的连接都交付了完整状态**才收到 `HA_UNWATCH`；在那之前它继续报，每一份新的全量状态到达时 Hub 再判断一次。所以只有一个名额时，Bot 先交完全量，机台才退出，连接不会闪成无状态。
- **Bot 作为监听者**：Koishi 插件的 `hello` 带 `{ha: true, name}` 才会被考虑（旧插件不声明，永远不会被分配）。Hub 用 `bot:<连接 id>` 记它，下发 `{"type":"ha.watch","watch":{term,connections}}`（内容与机台的 `HA_WATCH` 相同）、撤销 `{"type":"ha.unwatch"}`；Bot 上报 `{"type":"ha","method":"ha.status|ha.states","params":{…}}`，字段与机台一致，所以后面的任期、租约、去重、记录对两者完全相同。Bot 的连接断开（包括出错）立即让位给下一个候选；部署会让连接静默丢失，每次重新分配时都会对照仍在线的 Bot 连接清理，不等租约。Bot 重连是一个新连接、新 id，要重新 hello 才再被分配。监听名额由平台分配，店家不设开关；Bot 只要能连上 Home Assistant 就会被考虑。
- **下发**：`{"action":"HA_WATCH","body":{"term":3,"connections":[{"id":"ha_…","urls":["http://ha.local:8123","https://ha.example"],"token":"<只读令牌>","entities":["switch.a","climate.b"]}]}}`。`urls` 按顺序尝试，店内地址（HA 的 `internal_url`）在前，所有监听器收到的是同一个列表，平台不区分它在哪、是什么：HA 可能托管在别处，监听器也可能在店外，哪个地址通就用哪个。监听器侧每个地址有 10 秒连接超时，上次连上的排在最前，一轮全部失败才上报断开（见固件 `docs/remote-protocol.md`）；真实环境实测内部地址不可达时 10.2 秒变成实时（没有超时时是 75.2 秒）。每次下发用新的任期号。换人时给原来那台发 `{"action":"HA_UNWATCH","body":{}}`。只有已经签好只读账号、且有设备用到的连接会下发；一条都没有就不选人。
- **上报**（JSON-RPC 通知，无 `id`），两种监听者各有一条路径：
  - **机台 IO**：健康随 `io.heartbeat` 的 `ha[]` 一起发（每 60 秒一条，见上文心跳一节），平台把它逐条当成 `ha.status` 交给 Hub；状态用 `ha.states` 单独上报。
  - **Bot**：`ha.status {term, connection, connected, error?}` 在订阅建立或断开时、以及每 60 秒一次作为心跳；`ha.states` 与机台相同。
  `ha.states {term, connection, full, states:[{entity_id, state, last_changed, last_updated, attributes}]}`，第一次是全量，之后只报变化；时间是 HA 压缩状态里的 Unix 秒（也接受 ISO 文本），`attributes` 只带平台用到的空调属性。任何上报都给租约续期 150 秒；`term` 不是该监听者当前的任期，一律丢弃，所以交接时新旧两个任期短暂同时上报也无害。
- **去重与乱序**：两台监听者看到同一个事件，只记一次。Hub 按每个实体最近一次已应用的 `last_updated`（旧固件没有这个字段时退回 `last_changed`）判断：不比已应用的新就丢弃，所以一台晚到的旧事件不会把状态改回去。`last_updated` 要单独带，因为空调的温度、风速变化不会动 `last_changed`。设备事件的去重另有 SQL 保证：状态值没变就既不写事件也不写状态。两份报告同一时刻到达时 Hub 一份一份处理（`haReport` 排队），第二份要等第一份存完才判断，否则两份都会认为事件是新的、各推送一次。
- **换人**：监听者下线时立即补位；150 秒没有任何上报，Hub 的 alarm 把它排到后面并补位。**平台关机**（玩家、店员、闲置自动关机的 `power.off` 成功后），Hub 将共用电源的监听器一起置为待确认、保留任期并补齐正常名额；同组待命候选须重新上报证明存活，详见上文「关机之后的观察」。`ha.status` 报告连不上 HA 而店里还有没在盯的候选，立即换人；没有候选就保留，该连接回到无状态直到它重新订阅并交付全量。部署丢失连接时，IO 的存活检查会清理旧任务；IO 新会话接入立即重新分配，不以通道名相同为由保留旧任务。HA 报告租约仍用于识别“IO 在线但监听任务没有报告”的故障，不替代 IO 的存活判断。
- **记录**：上报的状态一批写入 D1（`bus.reportMany`，一次往返）。电源写 `power/power`（`on`/`off`/`null`）；空调写两个键：`climate/climate` 只含设定（模式、目标温度、风速），变化时记 `change` 事件，`climate/view` 是完整视图（含室温、可选模式、范围），只存储不记事件，因为室温会自己漂移。**时间用 HA 的 `last_changed`**，所以在米家或物理按钮开机，也能知道真正的开机时间。写入失败时不宣布该连接，并让监听者用新任期重新订阅（30 秒内最多一次），换回一份全量状态重写。
- **成本**：每次心跳只写一行存储（租约），且不重设 alarm，只在租约可能到期时才醒来；设备状态本身只在变化时写 D1。

#### 监听器数量与看板上的监听器区域

- **数量只有平台管理员能改，范围是单个店铺。** `PUT /api/v1/merchant/ha-watchers?shopId=`，body `{"count": 1–4}`，非管理员（包括这家店的店主）返回 403，越界或不是整数返回 422，店铺不存在返回 404。存在这家店的 `app_settings`（键 `devices.ha_watcher_limit`），默认 2，上限 `MAX_WATCHERS = 4`。写入后 Hub 重读（`refresh`），名额变大就补人，变小就按上面的规则让位。限制值读不出来或越界一律回到默认。
- **看板能看到谁在监听。** 资源页（有带电源或空调的资源时）的「HA 监听器」区域，数据来自看板那条 WebSocket 的 `watchers` 帧：`{"type":"watchers","limit":2,"max":4,"standby":1,"watchers":[{"id":"bot:…","kind":"bot","name":"前台","state":"watching"},{"id":"<机台 ID>","kind":"device","deviceId":"<机台 ID>","state":"starting"}]}`。连接建立时发一次，之后只在内容变化时发（监听者上线、让位、报告连不上 HA、数量变化）。Bot 排在前面，用它 hello 里的名字；机台用资源页已有的资源名。`state` 是 `watching`（已交付完整状态）、`subscribing`（等待 HA 全量状态）、`starting`（等待 HA 首次报告）、`confirming`（关机后等待心跳确认，不占正常名额）、`unreachable`（报告连不上 Home Assistant）；租约过期的不列。顶部监听器计数不包含 `confirming`，其原任务只为接收存活证明而保留。`standby` 是在线但没拿到名额的候选数。没有任何监听者时区域写明设备状态是非实时。
- 所有人都能看到这个区域和名额；下拉框只对平台管理员显示，店主看到的是「由平台管理员设置」。

#### 读取的接口

- `GET /api/v1/devices/session/bootstrap?ticket=`：扫码首屏一次请求拿到机台和（已登录时）页面状态；页面状态里的 `device: { watching, power, climate }` 是**已知的事实**，不问 HA。启用计费的店铺里，任何资源（包括没有硬件的二维码）的方案未在计费时 `gate` 为 `entry`，`billing.preview` 列出确认后开始、结束和继续的方案及 `revision`，无法计费时为 `billing.error`；见 [资源与资源组](resources.md)。`/session/state` 同样带 `device`；它的 `includePower` / `includeClimate` 默认仍现读 HA，给没升级的旧客户端用，新客户端传 `=0`。
- `GET /api/v1/devices/session/device?ticket=`：玩家页的兜底读取，只在页面和 Hub 的通道 3 秒内没说话（连不上或断开）时用。后端照常读（实时读存储，否则并发问 HA，不记录），返回 `{ watching, power?, climate? }`，`watching` 只给旧版 App Clip。`/session/power` 语义相同，只返回电源。
- `GET /api/v1/merchant/machines/states?shopId=`：看板的整店读取，用于**刷新按钮和 Hub 没给出状态时的兜底**。返回 `{ states: { [deviceId]: { watching, power?, climate? } } }`，只含带电源或空调的设备，每台只带它具备的能力：实时设备读存储，其余问 Home Assistant（并发上限 4，不记录），问不到的是 `null`。`watching` 只是标签。没有任何开关参数。店铺成员可读，非成员 403，缺 `shopId` 为 400。
- `GET /api/v1/merchant/machines/:id/state`：单台设备，读法同上。只为动作读回之前的旧版看板保留，当前看板不再调用。
- `GET /api/v1/merchant/machines/:id/mahjong`：返回 `{ mahjong }`（`{ capacity, seats: [{ playerId, name, playing }] }`，没有麻将能力为 `null`），给操作面板显示座位并选择下桌对象。座位不是 Home Assistant 状态，读它不会去问 HA。
- `GET /api/v1/merchant/machines/ws?shopId=`（WebSocket 升级）：看板的实时通道，连到该店的 Hub。只给店铺成员（非成员 403，缺 `shopId` 400，没有 `Upgrade` 头 426）；浏览器带了 `Origin` 就必须是平台自己的来源（`APP_ORIGIN` / `EXTRA_ALLOWED_ORIGINS`），否则 403，因为会话是 Cookie。路由把店铺 ID 和 `x-prism-hub-board` 交给 Hub 并去掉 `Authorization`，Hub 以 `board` 标签接受连接。帧：`{"type":"states","states":{<deviceId>:{watching,power?,climate?}},"liveConnections"?:[…]}`：连接建立时、以及哪些设备是实时的发生变化时发整店，实时设备带值，非实时设备只带标签；紧接着 Hub 把替非实时设备问到的值再以 `states` 帧发出（只含这些设备）。`{"type":"state","deviceId":…,"power"?:"on"|"off"|null,"climate"?:{…}|null}`：某台设备现在的样子（实时设备的变化，或非实时设备的动作读回），没说的键不是这次的内容。客户端对每一帧都只是把说了的键写到那台设备上，不判断是否实时。实时设备的变化要它用到的所有 HA 连接都已宣布为实时才推，所以一个连接的第一份快照不会逐台推，只在宣布之后以 `states` 整店帧发一次。客户端每 30 秒发一次 `ping`，Hub 的自动应答 `pong` 不会唤醒对象。
- **动作读回**：玩家和店员的开关机、空调动作成功后，后端读一次设备（`readAfterAction`，读法和其它读取一样：实时读存储，否则问 HA），读到的还没体现这个动作就在 0.4 秒和 1.6 秒时再读，最后一次就是答案。响应带 `device: { power?, climate? }`。设备不是实时的，这份结果交给 Hub（`deviceRead`），推给该设备的玩家页和所有看板；实时设备的变化由监听者的事件推送，Hub 忽略读回，免得旧值盖过新事件。Hub 自己的闲置关机不读回。

#### 扫码页

- 页面不分模式。首屏接口在设备实时时带电源和空调（不等 HA）。带电源或空调的设备，页面总是连上 `GET /api/v1/devices/session/ws?ticket=`（玩家登录态 + 设备二维码会话，WebSocket 升级），Hub 的 `hello` **从不等 HA**：实时设备带存储的值，非实时设备不带值，Hub 随后去问 HA，问到了用 `state` 帧补发。之后后端知道的每个新值都推过来。通道 3 秒内没连上（或断开后还没重连上），或者打过招呼但 10 秒内没说设备状态，页面读一次 `/session/device` 兜底，一次断开只读一次。还没有任何来源说过电源时，设备名后面显示「正在获取电源状态」，不阻塞选卡；说了是关机就直接切到电源页。HTTP 的回答和推送谁新用谁：请求发出之后收到过推送，就保留推送的值。
- 帧：`{"type":"hello","watching":…,"power"?,"climate"?}`；`{"type":"watching","watching":…,"power"?,"climate"?}`（模式变化，带设备现在的状态）；`{"type":"state","power"?,"climate"?}`（这台设备的新值：实时设备的变化，或非实时设备的动作读回，空调含室温）；`{"type":"refresh","reason":"binding"}`（页面显示的东西在别处变了，例如 Bot 刚确认了绑定，页面重新读一次状态）。网页把 `hello`、`watching`、`state` 一律当作状态，不读 `watching`。按下开机后先看响应里的读回：已经是开就放行，读不到（`null`）也放行，仍是关就等后端说开（15 秒没等到，按钮回来并提示「未检测到开机」）。机器被后台关掉时，玩家页同步切到开机页。Bot 绑定在通道连着时走推送，否则轮询。
- 旧版 App Clip 仍按 `watching` 自己判断模式：它需要的 `watching` 字段、`/session/state`、`/session/power` 和 `/session/device` 都保持可用；它在非实时时收到的 `state` 帧会忽略，所以新增的推送不影响它。
- 麻将座位不是 Home Assistant 状态，仍按原来的方式轮询。

### 闲置自动关机

两条规则，**默认都关**，由店长在「设置 → 位置与设备 → 闲置自动关机」打开（`GET/PUT /api/v1/merchant/idle-power?shopId=`，存在 `app_settings` 的 `devices.idle_power`）：

- **店里没人**：没有任何进行中的场次满 N 分钟（默认 15），关掉所有开着的电源和所有在运行的空调。先等待各设备占用结束，再执行关机；一段「没人」执行成功后不重复，失败按重试窗口再试。没人的起点取 Hub 记下的时间，没有就取最后一次结账时间。
- **单台设备闲置**：无人占用就是闲置，面板的 `0/n` 即为依据，不另存状态。打开 `device.enabled` 后，闲置满「闲置后关机等待时长」（`device.minutes`，默认 10 分钟，全店一个值）才自动关机。等待起点取「最近平台使用操作／开机时刻」与「占用结束时刻」中较晚的一个，不再额外叠加占用时长，见 [卡片、占用与查人](occupancy.md#闲置自动关机)。空调采用下文的整店条件。可以把设备设为「从不自动关机」（`PUT /idle-power/devices/:deviceId?shopId=`，`{ exclude }`）。店里没人且「店里没人」规则关着时到点关机；店里有人时可选择保持开机（兼容存储值 `whileOccupied: "mark"`）或闲置超时后关机（`"off"`）。旧的 `"remind"` 按 `"off"` 处理，继续预告并到时关机。

**预告与关机共用一个截止时间**：由 `planIdle` 一次计算预告时间、实际关机时间和下一次唤醒，Hub 到预告时间分发 `idle.reminder`，并保留到关机时间的 alarm；到点重新检查占用和活动后，以系统身份执行关机。例如设备无人占用后等待 N 分钟关机，Bot 配置提前 L 分钟，则闲置 N−L 分钟预告、N 分钟关机；L 完全取自 Bot 配置，没有固定 5 分钟。电源和空调都走同一套流程。Bot 设置决定是否预告、提前多久；Bot 离线、关闭预告或发送失败都不阻止平台关机。设备闲置关机在店里无人时同样预告；保持开机的设备不发送关机预告。期间刷卡、投币或延迟关机导致截止时间后移时，预告和关机一起重算，新截止时间可以重新预告；同一截止时间只预告一次。完成关机后的播报仍等待 HA 上报实际电源或空调开关变化。

有人占用的设备不会被关；占用怎么判断见 [卡片、占用与查人](occupancy.md#2-占用)。刷卡建立或刷新占用前，必须识别卡主，并查到该玩家正在按资源实际绑定的方案计费；资源覆盖方案优先于资源组方案。未绑定卡、无对应方案计费、只有其他方案计费或计费已结束都不会通过。平台投币沿用入口的计费校验和冷却。开机和延迟关机只重置关机等待，不产生占用，既不虚构玩家也不再额外保护一段占用时长。开机时刻来自事件驱动连接的 HA `last_changed`。占用到期和座位结束后仍保留结束时刻，不会跳过关机等待。旧设置中大于 0 的默认闲置时长继续作为关机等待时长读取。

**空调没有独立的闲置时钟**：不根据多久没开空调、切模式、调温或调风速计时。店内有人时，等待全部机台无人占用且关机等待结束，截止时间取所有机台关机等待截止时间中最晚的一个，预告仍使用 Bot 提前量。机台恢复使用，空调预告和关机一起重算。参与判断的包括电源机台、没有电源绑定的 IO 机台和座位资源；已确认关机的机台不阻止空调关机。机台的「从不自动关机」只排除关闭它的电源，仍参与整店使用判断。没有活动依据的未知电源缺少可靠的等待起点，不自动推断其等待已结束；没有任何可观测机台时，也不在有人时自动关空调。店内无人时按已启用的无人关机规则执行；只开设备闲置规则时，从无人起点经过等待时长再关闭空调。空调的排除设置和实际占用仍有效。「保持开机」策略不会主动关空调。

**设备状态未知时规则照样执行**（连接是无状态模式，或 HA 报告不可用）：自动关机不依赖设备的实际状态。「店里没人」规则对每台没有明确关着的设备都下发关机，空调同理，往已经关着的设备再发一次关机没有害处。「单台设备闲置」规则没有开机时刻，只能以设备自己的最近活动为时钟：没有任何活动就没有起点，不处理；超时后关一次，之后只要它在上次关机之后没有新的活动就不再重复，因为没有状态能证明那次关机生效了。已知状态只来自事件驱动的连接，无状态连接上存着的旧值不会被采信。

**共享电源／空调**按「能力 + HA 连接 ID + 实体 ID」合并判断：等待所有关联资源的占用结束并经过关机等待，采用最晚的关机截止时间。任一资源设置了「从不自动关机」，该实体整组不自动关；资源的电源和空调编辑面板都可设置这个资源级开关。预告合并列出全部受影响资源名，只下发一次关机，整组共用重试窗口。不同 HA 连接上的同名实体互不影响；手动指定某个资源关机仍会操作它绑定的真实实体，因此同电源的其它资源也会断电。

**执行**由店铺 Hub 负责：只记最后活动时间，不逐秒倒数；alarm 设在占用结束、预告或关机的下一个时间点。刷卡信号、扫码操作、刷卡登录、店铺接口的任何写操作（入场、结账等）和设置保存都会「碰一下」Hub，2 秒内的多次合并成一次检查。信号只触发重算，不会因为唤醒本身延期；无资格的卡不改占用和等待时间。检查时从 D1 读设置、进行中的场次、事件驱动连接上设备的电源与空调状态和最近 24 小时的活动，交给 `planIdle` 决定，然后以**系统身份**（`{type:"system"}`）执行 `power.off` / `climate.off`，不刷新倒计时。失败后 10 分钟内不重试。关掉监听 HA 的机台时，Hub 同时标为下线并补位。不再读取或写入设备的 `idle` 状态，不产生新的「已闲置／恢复使用」事件；既有历史保留。

**关机时间**：`planIdle` 同时算出 `powerOffAt`，只包含已开始等待且将自动关机的设备；保持开机策略、占用尚未结束的设备没有倒计时。机台占用结束时重新检查并发布倒计时，无需等到预告时间。无人关机采用自身截止时间，空调采用上文的整店条件。Hub 保存的是关机计划而非设备闲置标记；`GET /api/v1/merchant/machines/occupancy` 带上 `powerOffAt`（设备 ID → 时间，已过去的不列）。后台按店铺时区显示「HH:MM 自动关机（N 分钟后）」，剩余分钟数按绝对时刻计算；随占用每 30 秒刷新，已确认关机时不显示。

**延迟关机**：`power.keep`（电源能力的动作，玩家要求已入场、算作「玩过」；店员可直接操作）。面板的 `POST /api/v1/merchant/machines/:id/actions` 与扫码动作接口都接受它，写入同一设备活动记录，由 Hub 重算关机等待与截止时间，共享电源和空调也会跟着调整。它不向 HA 下发开机命令，设备开着才成功；已关机或状态读不到时拒绝，所以延迟永远不会把设备开起来。玩家在扫码页点「开机」效果相同。

### 设备日志

`GET /api/v1/merchant/machines/:id/events?limit=50`（1–200）按时间倒序返回该设备的事件：

```json
{ "events": [
  { "id": "...", "capability": "hinata_io", "kind": "signal", "name": "card.consumed", "origin": "device",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:02.000Z",
    "payload": { "card": { "source": "6f1c…" } } },
  { "id": "...", "capability": "hinata_io", "kind": "result", "name": "aime.scan", "origin": "platform",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:00.400Z", "payload": { "outcome": "ok" } },
  { "id": "...", "capability": "hinata_io", "kind": "request", "name": "aime.scan", "origin": "platform",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:00.000Z", "payload": { "cardId": "card-1" } }
] }
```

`origin` 为 `platform`（平台发起）、`device`（设备回报）或 `observer`（平台读外部状态时发现变化）。看板把同一操作的 `request` 与 `result` 合并成一行。

**由事件触发操作目前只预留、未实现。** 投币要先抢冷却锁、刷卡要先确定玩家，在确定哪些动作能安全自动执行之前，事件只被记录和读取。

### 旧接口

`/rpc/machine/ws`（原生机器软件 WebSocket 与 `machine_ws` 执行器，只有本地 Bun 服务端提供过，Worker 部署从未开放）已移除；机台改用 `/io/ws` 直连。`GET /rpc/staff/machine-connections` 保留，内容改为直连机台的 `link` 状态。`/api/v1/merchant/device-bindings` 保留但总是返回空列表（注册表已自动转为设备）。旧的 `device_commands`、`device_states`、`machine_connections` 表与 `machines` 上的能力列由迁移 0037 复制到新表后不再写入，保留一个版本以便回滚。

Cloudflare Workers 运行时通过保持原生 `fetch` 调用上下文的包装函数访问 Home Assistant，避免把运行时函数作为普通对象方法调用而触发 `Illegal invocation`。

### 余额不足提示

Web 与 Swift（主 App / App Clip 共用 API 层）按 `INSUFFICIENT_BALANCE` 错误码显示本地化提示：中文“余额不足，请充值后重试”，英文“Insufficient balance. Please top up and try again.”。内部诊断文本变化不影响提示；HTTP 状态与错误码保留，余额不足不视为会话失效。结账被拒绝后保留当前账单和计费状态，不自动重发结账；充值后可手动重试，并使用新的操作 ID。
