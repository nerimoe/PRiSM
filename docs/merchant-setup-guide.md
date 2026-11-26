# 商户工作台的开店指引

店长第一次进入工作台，往往不清楚这套系统在店里怎么运转、钱从哪来、玩家会经历什么，也不知道该先点哪个页面和按钮。「开店指引」页签以图解优先的界面和游戏式跨页互动引导，带着店家边看图边完成真实配置，并根据现有接口判断每一步是否已完成、标出需要留意的硬件或接入提示。

实现见：
- `packages/prism-web/src/ui/merchant/ShopGuide.tsx`（指引首页、进度状态读取与各环节卡片）
- `packages/prism-web/src/ui/merchant/setup-guide.ts`（纯推导与步骤完成判定，测试在 `setup-guide.test.ts`）
- `packages/prism-web/src/ui/merchant/setup-tour.ts`（纯互动引导步骤编排与路由/索引工具，测试在 `setup-tour.test.ts`）
- `packages/prism-web/src/ui/merchant/tour-context.tsx`（无环依赖的引导上下文与弹窗内提示条 `TourModalBanner`）
- `packages/prism-web/src/ui/merchant/SetupTour.tsx`（跨页自动跳转、聚光灯高亮浮层与持久化）
- `packages/prism-web/src/ui/merchant/GuideDiagrams.tsx`（可复用内联 SVG 图例，供指引画廊与引导浮卡共用）
- `packages/prism-web/src/ui/merchant/BillingExplainer.tsx`（计费图解说明书弹窗）

## 经营方式

不单独存字段，由现有设置推出（`operatingMode`）：

| 经营方式 | 判定 | 含义 |
| --- | --- | --- |
| 不使用计费（`devices`） | 没有任何资源组或资源设置计费方案 | 只用 PRiSM 的设备功能（开机、调空调、刷卡、按键、投币、启动器、IoT、门锁、桌游），收费在店家自己的其它经营平台完成 |
| 自助计费，无前台（`self`） | 有资源计费、未开前台收银 | 玩家在手机上入场计时、离店自助结账，从预存余额扣款；常见于无人值守、在线上群里运营的店。即使有店员，店员也不负责收钱 |
| 前台收银（`desk`） | 有资源计费、开启前台收银 | 有前台的店一定在前台收钱：玩家刷实体卡入场（按「前台资源」方案计时），离店时现场付款；带手机的玩家也可以自助 |

「有资源计费」由 `shopBills` 判断：任一资源组（含默认资源组）或资源专属方案已设置。这只是描述，不是开关——店铺没有整店计费开关。建店向导第一步就是三选一（「店里怎么收费？」）；「不使用计费」只是不创建方案，之后给哪个资源组或资源设置方案，哪里就开始计费。前台收银在「设置 → 营业与计费」切换，开启时须选定「前台资源」。选前台收银时，`POST /api/v1/merchant/shops` 的 `billingSetup.cashierEnabled: true` 会同时开启前台收银并创建名为「前台」的资源（`desk-<shopId>`）。

## 何时出现、默认落点

- 只对店长（owner）显示。
- 有未完成步骤时，「开店指引」排在页签最前，`/merchant/:shop` 默认跳到 `/merchant/:shop/guide`；全部完成后页签消失，默认进入「仪表板」，设置页标题右侧保留入口。
- 在仪表板查看实时计费时，可直接点击「玩家」或「资源」切换页面，无需刷新。
- 新建店铺的向导结束后直接进入指引。向导选择创建 Bot 凭据时，完成页直接展示两项配置（`接入凭据` 与 `API 地址`），凭据自己指明店铺，不再展示店铺编号。

## 页面结构（图解与行动优先）

1. **顶部引导启动台（Hero Launchpad）**：展示当前经营方式与一句话摘要、「更改方式」链接、可视化进度条与完成计数，以及主操作按钮「开始新手引导 / 继续新手引导 / 重新体验引导」（有进度时可点「从头引导」；开启计费时提供「计费图解说明书」入口）。
2. **接入步骤（直接置顶于启动台下方）**：按经营方式列出精简后的关键步骤卡片，标出「当前推荐 / 待完成 / 已完成」、实时诊断与硬件告警；每张卡片旁均提供「带我操作」按钮直接从该步启动互动引导，也保留直达页面链接。
3. **系统结构与流程示意（`ConceptGallery`）**：将原大段纯文字整合为 4 组可切换 SVG 图例页签（均由 `GuideDiagrams.tsx` 渲染）：
   - **店铺与设备结构**：
     - 计费模式下以真实音游店**「月宫」**为原型逐步递进展示 3 个可切换实例，清晰区分「默认组」「单台专属覆盖」与「新建资源组」的边界：
       - **例 1：「月宫」实配（仅默认组，`store-hierarchy`）**：舞萌DX、中二节奏-左/右、音击与门锁全部留在自带的「默认资源组」绑一套基础计划（¥4/30分 · 封顶¥40），扫门锁或任一机台入场后全店通用（仅供已入场玩家调的空调同样留在默认组，不重复收费；QQ Bot 独立无二维码）。
       - **例 2：单台例外（仍不用建组，`store-example-override`）**：当只有个别设备规则不同（例如希望玩家未入场前也能通过 `¥0` 专属方案提前开空调，或新增 1 张设 `¥0` 等位专属方案 + 对局方案的独立桌游桌），依然留在「默认资源组」里用单台「资源专属方案 / 桌游对局方案」覆盖即可，不需要新建资源组。
       - **例 3：多台分区（才需建新组，`store-example-zone`）**：只有当新辟出包含多台设备的区域（如二楼 VIP 包间多台框体 + 门锁 + 空调统一定价，或多设施免费休息区），为了成批绑定方案、一键整组调价或暂停开放，才新建第 2 个资源组。
       - 其下宽幅展示 `resource-abilities`（单个资源按需插上刷卡 · HINATA IO、机台按键、投币、启动器、电源控制、空调、开门密码、IoT 控制器、桌游、店铺 Bot 共 10 种能力）。
     - 不使用计费模式下展示 `store-hierarchy`（默认资源组免计费统一管理设备）与 `resource-abilities` 两栏图解。
   - **玩家怎么用**：前台模式展示「连读卡器 → 刷卡入场 → 店内游玩 → 现场收款」流程；自助/不计费模式展示「扫码 / 碰 NFC（iPhone 灵动岛 App Clip）→ 登录绑身份 / 确认规则 → 操控设备 → 离店结账」。
   - **钱从哪来、怎么扣**（有资源计费时显示）：展示兑换码 / 店员手动充值 / 礼物与活动 → 账户余额（赠送余额 + 充值余额）→ 结账顺序（优惠券 → 赠送余额 → 充值余额）与前台现场收款对比，并附打开 `BillingExplainer` 的入口。
   - **日常后台怎么管**：展示「仪表板」4 项实时 KPI、设备状态磁贴、在店玩家与批量结账及各页签分工胶囊。
4. **按需进阶功能（可折叠 `<details>`）**：默认收起 Bot 播报组、闲置自动关机、投币上限/后台按键、分区计费、邀请店员、新玩家礼物、优惠活动、切换经营方式、到店位置校验、数据备份与从 prism-neo 迁移共 10 类进阶能力，摘要区提示关键入口并支持一键展开。
5. **PRiSM 接入支持与反馈（`PlatformSupport`）**：底部紧凑横条展示官方支持 QQ 群号（`1135111765`）与「复制群号」按钮。

## 游戏式跨页互动引导（`SetupTour`）

`SetupTourProvider` 挂载在 `MerchantPage` 工作台内，切换任意店主页签都不会中断引导：

- **智能编排（`buildTourSteps`）**：根据店铺当前经营方式（`devices` / `self` / `desk`）、身份策略、Bot 连接状态、门锁配置及缺失项（`pricingProblem === "assets"`、`deskProblem === "missing"`）动态生成步骤序列：
  - 通用开头：`resources-group`（以「月宫」真实单默认组配置为例说明全店一票通玩，无需额外分组）→ `resources-add`（添加资源与 10 种能力）。
  - 计费步骤（`billing`）：缺失余额资产时先引导 `pricing-assets`；前台缺资源时先引导 `pricing-desk-resource`；随后走过 `pricing-plans`（方案与时间轴版本，支持直接打开计费图解）与 `pricing-bindings`（通过 `store-example-override` 说明全场通玩只需绑好默认组、单台例外直接用专属/对局方案覆盖而无需建组，并提醒点「保存全部修改」）。
  - 前台步骤（`desk`）：`cashier-reader`（在仪表板连接读卡器）→ `staff-invite`（邀请店员并设为「管理」）。
  - 身份步骤（`identityMatters`）：`identity-policy`（设置进店方式与绑定提示）；若需绑 Bot 且未连接，紧接着引导 `identity-bot-add`。
  - 储值步骤（`self`）：`prepaid-gift`（建充值礼物）→ `prepaid-code`（批量生成并导出兑换码）。
  - 门锁步骤（有门锁设备时）：`door-ttlock`（自动展开 `settings-ttlock` 折叠面板）。
  - 收尾：`qr-trial`（资源卡片二维码 / NFC 试扫）→ `dashboard-overview`（熟悉仪表板日常看店，完成后返回指引页）。
- **跨页自动跳转与聚光灯**：进入每一步或从收起状态恢复时自动跳转到目标路由与查询参数，查找首个可见的 `[data-tour]` 目标元素（跳过 `hidden` 与零尺寸面板；如目标暂未出现，按 `fallbackTarget` 兜底），通过全屏 SVG 遮罩镂空与 `.tour-spotlight-ring` 脉冲框高亮按钮，同时不阻断点击真实按钮。
- **步进图解与弹窗内提示**：浮卡内嵌当前步骤对应的 `GuideDiagram`、简短概念说明与操作指示，并支持键盘 `ArrowLeft` / `ArrowRight` / `Escape`、收起为右下角胶囊继续浏览、以及跨页切换时通过 `sessionStorage`（`prism.setup.tour.<shopCode>`）保持进度。当用户直接点击高亮按钮打开 `<Modal>`（原生 `<dialog>` 顶层模态框）时，全屏聚光灯自动避让，模态框顶部展示 `TourModalBanner` 操作提示；关闭模态框后自动刷新 `SetupStatus` 更新完成徽标。

## 接入步骤与完成判定

| 步骤 | 出现条件 | 完成条件 |
| --- | --- | --- |
| 设定收费标准 | 有资源计费 | 有有效余额资产（缺失时引导去「资产」恢复）；前台收银模式下还要求 `cashierResourceId` 指向一个已启用且实际有计费方案（专属或所属资源组）的非 Bot 资源（缺失或未设方案时 `deskProblem` 标红提示并引导去「设置 → 营业与计费」或「资源」）。哪些资源组计费在「资源」页设置，非前台场景资源组不设方案（免费）不算未完成 |
| 准备前台读卡器 | 前台收银 | 本浏览器已授权 HINATA 读卡器（WebHID `getDevices()` 中有 vendor `0xF822`）；浏览器不支持 WebHID 时提示用桌面版 Chrome 或 Edge |
| 给前台店员开账号 | 前台收银 | 店铺成员多于 1 人；说明在前台收款需要计费权限「管理」，且店员绑定平台身份后自动成为 Bot 管理员 |
| 确认玩家身份与 Bot | 有资源计费；或有门锁、桌游桌 | 不要求绑定；或至少一个已启用的 Bot 资源拥有有效凭据，且 `botOnline` 为真或 `botLastUsedAt` 非空。步骤内可直接改身份策略、预览绑定提示，并说明在「资源」页添加 Bot 后 Koishi 插件只需填 API 地址和接入凭据两项 |
| 准备玩家储值 | 自助计费 | 有可用兑换码（未用尽、未过期），或已有玩家余额大于 0 |
| 添加资源并配置能力 | 总是 | 至少一个非 Bot 店铺资源，且每个非 Bot 资源要么配置了至少一项能力，要么自身/所在启用资源组绑定了计费方案（`resourceBilled`；纯二维码入口与自动创建的「前台」资源若已绑计费方案即算配置完成，仅创建 Bot 资源不算完成此步）。步骤内同时展示不阻塞完成判定的配置提醒：直连 IO 仍在 E2EE、直连 IO 未签发设备令牌、投币能力未选按键、HA 连接只读账号未就绪，以及外部中继建议改直连提示 |
| 连接 TTLock 账号 | 有资源启用开门密码 | `ttLockConnection` 有 `clientId`、`clientSecret` 及 `accessToken` 或 `appAccount` |
| 贴好二维码或 NFC，自己试一次 | 总是 | 有资源计费且已有玩家档案；或店长勾选「我已试过」（`localStorage` 的 `prism.setup.trial.<shopCode>`） |

### 接口读取边界

`useSetupStatus` 在所有店主工作台页签挂载时复用同一份 8 个现有 GET 接口加载进度（`settings`、`merchant/machines`、`merchant/resource-groups`、`staff/settings`、`staff/players`、`merchant/shop-members`、`staff/presents`、`staff/redeem-codes`，`resource-groups` 失败时退回 `undefined` 以免误报 `unbilled`），不新增跨页请求，避免影响其它页面的接口约束。已创建 Bot 凭据但尚未接入时，每 15 秒自动复查一次，Bot 接入后自动更新；可选接口失败不阻塞工作台。

仅当真正打开「开店指引」页（`ShopGuide` 组件挂载）时，页面额外以 `.catch(() => null)` 读取两项只读诊断信息：
- `GET /api/v1/merchant/idle-power?shopId=`：判断「按需进阶功能 → 闲置自动关机」是否已开启。
- `GET /api/v1/merchant/ha-connections?shopId=`：统计 `readAccess` 为 `needs_admin` 或 `failed` 的 Home Assistant 连接数，在「添加资源并配置能力」步骤内提醒启用只读账号以恢复实时状态。

## 界面主题与布局

全站共用的顶部导航栏随系统浅色／深色主题切换背景色，并保留半透明毛玻璃效果；深色模式下与页面背景保持一致。SVG 图形图例（`GuideDiagrams` 与 `BillingExplainer`）随主题自适应，而互动引导层（聚光灯脉冲框 `.tour-spotlight-ring`、浮动指示标签 `.tour-pointer-tag`、引导操作按钮 `.tour-btn` 与弹窗提示条）使用独立于主品牌蓝的琥珀金强调色（`--color-tour`），避免与页面自身的蓝色业务按钮混淆。桌面端商户工作台（`.merchant-workspace`）容器加宽至内容区最大 `1520px`（外层容器 `1568px`），并同步对齐顶栏宽度，不影响玩家端与登录页布局；「仪表板」的设备概览中直连 HINATA IO 在线且已有读卡器时显示「IO 在线」（不再重复显示 `读卡器 n`），仅在 IO 在线且读卡器数量为 `0` 时提示「无读卡器」。

## 玩家身份

`IdentityPolicyPicker.tsx` 在指引和「设置 → 玩家与身份」共用，两个选项，绑定在前：

- **要求绑定平台身份（推荐）**：玩家第一次进店前把绑定码发给店铺 Bot。店家因此知道每位玩家的 QQ 号等身份，Bot 也会自动同步玩家在聊天平台上的昵称；Bot 只在店铺群里响应时，只有群成员能进店。其下的高级勾选项「只允许已有档案的玩家绑定」（`autoRegister: false`）只用于迁移来的店，任何情况下都不作为默认值。
- **登录网页账号即可**：不需要 Bot，店家只知道玩家的 PRiSM 账号。

新店铺默认要求绑定并自动建档（含没有资源计费的店铺）。绑定提示、Bot 的命令权限、播报组与回复模板见 [integrations-and-machines.md](integrations-and-machines.md) 的 Integration 一节。

## 计费说明书（`BillingExplainer`）

`BillingExplainer` 用一个连贯的例子画四张图，数字与计费引擎一致（[billing-flow.md](billing-flow.md)），并附字段说明与配置注意事项：

1. **按单位计费、宽限内不进位**：每 30 分钟 10 元、宽限 5 分钟的阶梯图，35 分钟 10 元、36 分钟 20 元；开场宽限只在没操作设备时免单（开门、调空调与后台按键不算设备操作）。
2. **跨时段分别计算、时段封顶只管本时段**：日场 12 元/小时封顶 40、夜场 8 元/小时，14:00–20:30 共 64 元的累计曲线；并说明入场锁定规则版本。
3. **多条计费与消费封顶**：入场 64 元 + 桌游 30 元，全天消费封顶 80 元（消费封顶不再选适用规则，覆盖所有按时计费的规则）。
4. **结账扣款顺序**：94 → 消费封顶 −14 → 优惠券 −6 → 应付 74，先扣赠送余额 20、再扣充值余额 54。

字段说明除计费方式、基本信息、按时计费时段（含负数收费表示活动时段减免）、固定收费、消费封顶外，还说明了规则关系（「依赖」与「冲突」）；配置注意事项说明新建规则须成为资源组方案、资源专属方案、桌游对局方案或被其他规则「依赖」才会计费，并涵盖桌游「人满后一起开始」与「上桌立即开始」两种开局模式及直接换桌行为。末尾链接到计费页的计费模拟器（`/merchant/:shop/pricing?simulate=1` 直接展开），用本店规则试算。

## 资源入口：二维码与 NFC

二维码和 NFC 是同一个链接 `/t/:shop/:resource`。玩家打开后，设置了计费方案的资源先显示「计费规则」卡片（各方案今天的时段、跨方案封顶的进度和已计金额），确认后才开始计费；直连 HINATA IO 机台支持时，玩家还能在选卡区点「+」，把卡放到这台机器的读卡器上直接添加。NFC 标签写入 NDEF URI 记录即可；iPhone 碰一下唤起 hinata_go 里的 PRiSM Link App Clip（免安装，支持灵动岛实时更新账单），其它手机用浏览器或 HINATA Go 打开。资源二维码弹窗提供打印、复制链接，并写明 NFC 的写法。

## 验证

```bash
bunx vitest run packages/prism-web/src/ui/merchant/setup-guide.test.ts packages/prism-web/src/ui/merchant/setup-tour.test.ts packages/prism-web/src/i18n.test.ts
bun test --timeout 30000
bun run typecheck
bun run check:platform
```
