# 前台收银（React Web，低安全模式）

用于有工作人员的店铺：玩家持实体卡到前台入场与结账，店铺负责人在 React 商户管理页面的「设置」中手动打开「启用前台收银」，店员在「在店」页面连接 HINATA 读卡器后等待刷卡。前台收银模式默认关闭，启用后与在店玩家列表共用一个页面，不增加独立导航标签。店铺须启用计费，店员须拥有 owner 或 manager 权限；viewer 不能进行前台操作。复用店铺现有入场计费方案、价格版本、封顶规则和账单时间线，无需玩家 GPS 或设备二维码。

## 操作流程

1. 负责人进入「设置」，勾选「启用前台收银」并保存。存在进行中或已停止但未付款的前台计时时，须先收款结账才能关闭模式。关闭后保留已有昵称档案、卡片绑定和收款记录，再次启用可继续使用原卡。
2. 使用支持 WebHID 的桌面 Chrome / Edge，通过 HTTPS（开发时 localhost 也可以）打开管理页面，点击「连接读卡器」并授权 HINATA 设备。关闭其他占用该读卡器的程序或浏览器页面。
3. 新卡刷入后，询问玩家昵称，点击「登记并入场」。仅创建当前店铺的计时档案并绑定基础 ID，不创建 PRiSM 账号、不要求 QQ、不发注册赠品。
4. 已绑定卡再次刷入时，无未结账计时则显示「确认入场」；有进行中或已停止但未结账的计时则显示账单。入场和结账均须店员确认，刷卡本身不会扣款或结束计时。
5. 结账时按显示金额通过店铺自己的微信、支付宝、现金或其他方式收款，勾选「我已通过上述方式收到款项」，点击「确认已收款并结账」。PRiSM 记录原始账单、收款方式、收银员和收款时间，不连接第三方支付系统，也不扣除或创建任何资产。
6. 金额与计时截止到该次账单预览时间，确保收款时不会因跨过计费边界而多收或少记。预览十分钟后过期；计时或金额发生变化也会拒绝提交，请刷新账单、核对金额后再确认。取消结账不会停止计时；在店页面的「停止计费」仍保留未付款账单，之后可在前台收款。
7. 操作成功后回到等待刷卡状态。同一张卡留在读卡器上不会反复触发；移开卡片再刷。处理当前玩家期间刷另一张卡不会替换当前玩家，页面会提示完成后重新刷卡。

读卡登记、入场和收款成功后，「在店」列表会自动刷新；在店账单的「前台收款」和玩家资料中的「前台收银」均在「在店」页面处理对应档案。刷卡或点击「前台收款」时，页面会滚动到收银区域。「营业记录」区分现场收款与资产结算并显示收款方式。正常账号玩家的资产与自助计费流程保持原有行为。

## 卡片和安全边界

参照 [Project-HINATA/hinata_go](https://github.com/Project-HINATA/hinata_go) 的 `hinata_reader.dart`、`pn532.dart` 和 `usb_hinata_impl.dart`：使用 WebHID vendor ID `0xF822`，output/input report ID `1`，桥接命令 `0xE2`，PN532 `InListPassiveTarget` 查询 FeliCa 和 ISO14443 Type A。沿用标准版与 Lite 版的 Type A RF 参数档位。只读取 Type A UID（4/7/10 字节）或 FeliCa IDm（8 字节），不要求 Aime、Banapass、交通卡等应用格式、不读取受保护扇区、不导入游戏卡 access code。

这里的「任何卡片」指读卡器能通过上述协议读取基础 ID 的卡片。ISO15693、Type B、手机系统 NFC、非 HINATA WebHID 设备和高安全模式不在本次实现范围内。随机 UID 的手机或卡片不适合作为稳定入场凭证。真实设备仍需现场确认固件和浏览器兼容性。

UID 可以被复制，仅用于店员监督下的店内计时档案。卡片档案按店铺及卡片协议类型隔离，相同基础 ID 在不同店铺可绑定不同玩家；该凭证不授予账号登录或资产权限。数据库和 API 拒绝为此类档案保存资产或绑定玩家登录身份。前台档案不能经普通余额结账入口结账，须显式确认现场收款。

## API 与数据

店铺 `GET /api/v1/shops/:shopCode` 和 `GET /api/v1/shops/:shopCode/settings` 返回 `cashierEnabled`（无配置时为 `false`）。负责人通过 `PUT /api/v1/shops/:shopCode/settings` 提交 `cashierEnabled` 手动启停；旧客户端省略该字段时保留已有值。开关保存在已有 `app_settings` 的 `cashier.settings` 键，开启须同时启用计费，关闭须结清所有前台未付款计时。设置更新和登记、入场、收款共用店铺操作锁，避免关闭与新入场并发留下无法结账的计时。

平台 API 前缀：`/api/v1/shops/:shopCode/cashier`，沿用商户账号会话、来源校验和店铺 staff 权限。模式关闭时这些接口返回 `409 CASHIER_DISABLED`；关闭被未付款前台账单阻止时设置接口返回 `409 CASHIER_UNSETTLED_SESSIONS`。

- `POST /lookup`：`{kind:"type-a"|"felica", uid:"十六进制"}`，返回 `{profile:null|档案}`。
- `POST /register`：`{card:{kind,uid},displayName,operationId}`，创建空资产档案并绑定卡片。
- `GET /profiles/:playerId`：返回档案及所有未结账计时。
- `POST /profiles/:playerId/entry`：`{operationId}`，使用当前店铺入场计费方案开始计时。已有入场计时不会重复创建；已停止的未付款计时须先结清。
- `POST /profiles/:playerId/checkout/preview`：返回既有账单格式，包含 `settlementPreview.previewedAt`、`sessionIds` 和以元表示的 `total`。
- `POST /profiles/:playerId/checkout/confirm`：`{operationId,collected:true,method:"wechat"|"alipay"|"cash"|"other",expectedTotal,previewedAt,sessionIds}`。只有前台卡片档案可用，按预览截止时刻计算并核对金额与计时。`operationId` 必须为 UUID，网络重试使用原编号，以免重复处理。

新表 `cashier_profiles` 保存卡片绑定，`cashier_payments` 关联已有 `player_checkouts`，记录收银员、方式和时间。结账、会话关闭、价格历史与收款记录在同一数据库事务内提交；不创建资产交易或扣款流水。

Cloudflare D1 部署须应用 `migrations/0029_cashier.sql`（正常 `deploy:worker` 流程会执行未应用迁移）；本地 SQLite 运行时会通过既有 schema 初始化自动添加表和保护触发器。无须更改现有玩家数据或配置支付密钥。

验证命令：`bun run typecheck`、`bun run build:web`、`bun test --timeout 30000`。收银 API 可单独运行 `bun test packages/platform/test/cashier.test.ts --timeout 60000`。如果全量单进程运行中出现 Miniflare 运行器超时或共享模拟状态错误，可按测试文件使用独立 Bun 进程验证平台集成测试，保持所有断言启用。读卡协议单元测试使用模拟 HID 设备，收银接口测试使用真实 Miniflare D1；这些测试不替代实体刷卡实测。
