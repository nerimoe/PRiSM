# PRiSM Dashboard 全新后台管理重写设计规格书

本文档概述了将 `prism_dashboard` (Flutter Web Admin) 从静态预览状态重写为完整且包含测试的店员工作流所需的架构、数据模型、UI 组件以及页面功能设计。

---

## 1. 架构概述

后端在 `packages/rpc/src/index.ts` 中的 `staff` 命名空间下暴露了类型安全的 RPC 接口。
Dashboard 客户端通过 Riverpod 容器中注册的 `PrismApiClient` 提供者与服务端进行通信。

### 状态与 API 客户端模式
数据模型将采用 **自动生成方案（方案 A：freezed + json_serializable）**，以减少手写 `fromJson`/`toJson`/`copyWith` 样板代码，提高开发效率并防止拼写错误。
- **依赖库引入**：
  在 `pubspec.yaml` 中引入 `freezed_annotation` 和 `json_annotation` 作为运行依赖，以及 `build_runner`、`freezed` 和 `json_serializable` 作为开发依赖。
- **构建命令**：
  每次修改模型定义后，需执行以下命令以生成 `.freezed.dart` 和 `.g.dart` 代码：
  ```bash
  PATH="${FLUTTER_HOME}/bin:$PATH" flutter pub run build_runner build --delete-conflicting-outputs
  ```
- **客户端**：[PrismApiClient](../../../packages/prism-dashboard/lib/src/api/api_client.dart)
  - 扩展底层的 `_request` 方法以支持 `PUT`、`PATCH` 以及自定义的 URL 查询参数（Query Params）。
  - 实现封装了 Hono 后端路由的所有店员（staff）RPC 接口方法。
- **数据模型**：[models.dart](../../../packages/prism-dashboard/lib/src/api/models.dart)
  - 使用 `@freezed` 注解声明强类型数据模型。
  - 在类定义中引入 `with _$[ClassName]` 并实现 `factory [ClassName].fromJson(Map<String, dynamic> json) => _$[ClassName]FromJson(json);`。

---

## 2. 模型与 API 契约

我们将使用 `freezed` 声明以下店员端业务实体：

- **玩家与资产**：
  - `Player`：包含 `id`、`displayName`、`status`（"active" | "inactive" | "banned"）、`walletTotal`、`stayDurationMinutes`。
  - `PlayerAssets`：包含 `playerId`、`holdings`（`AssetHolding` 列表）、`ledger`（`AssetLedgerEntry` 列表）。
  - `AssetDefinition`：包含 `type`（如 "currency", "token"）、`code`（如 "paid", "free"）、`displayName`、`isArchived`。
  - `AssetHolding`：包含 `assetType`、`assetCode`、`amount`。
  - `AssetLedgerEntry`：包含 `id`、`assetType`、`assetCode`、`amount`、`direction`（"in" | "out"）、`reason`、`createdAt`。
- **礼物与兑换码**：
  - `Present`：包含 `id`、`name`、`grants`（`AssetGrant` 列表）、`isArchived`。
  - `RedeemCode`：包含 `id`、`code`、可兑换的礼物或资产、使用限制、已兑换次数、过期时间、是否已失效。
- **计费配置**：
  - `PricingConfig`：包含 `id`、`name`、`kind`（"time.priority" | "fixed"）、`rules` (List of `PriorityTimeRule`)、`isArchived`、`isActive`。
  - `PriorityTimeRule`：包含 `label`、优先级、开始时间、结束时间、星期过滤、特定日期、单位计费分钟数、单位价格、宽限期分钟数、计费封顶金额。
  - `PricingTimeline`：包含 `timeline`（分段计费区间列表）、`pricingConfigId`。
- **服务项目与订单**：
  - `BusinessItem`：包含 `id`、`name`、`price`、`kind`（如饮料、包厢服务等）、`isArchived`。
  - `BusinessItemOrder`：包含 `id`、`playerId`、`itemId`、`itemName`、`price`、`status`（"pending" | "fulfilled" | "cancelled"）、下单时间、核销时间、取消时间。
- **设备**：
  - `DeviceState`：包含 `deviceId`、`label`、类型、在线状态（"online" | "offline" | "degraded"）、上报时间、上报网关。
  - `DeviceCommand`：包含 `id`、指令类型、`deviceId`、下发者、执行状态（"pending" | "acked" | "expired"）、下发时间、网关响应时间。
- **营业报表**：
  - `ReportSummary`：包含总营收、已结算计时总数、资产赠送总数、投币指令总数。
  - `SettlementReportRow`：包含玩家 ID、显示名、结算时长、应付金额、实付金额、结算时间。
  - `PlayerReportRow`：包含玩家 ID、显示名、结算次数、累计在店时长、累计消费额、最近一次结算时间。
- **系统设置与员工管理**：
  - `SettingsData`：店铺名称、时区、投币冷却时间。
  - `StaffUser`：包含 `id`、用户名、显示名、角色（"owner" | "manager" | "viewer"）、是否已禁用。
  - `ApiToken`：包含 `id`、标签说明、密钥明文（仅在创建时返回一次）、创建时间、是否已失效。

---

## 3. 共享后台 UI 组件与视觉系统约束

全新后台的所有交互组件都必须承袭 `/prism-dashboard` 的 UI 风格规范，并且基于以下核心约束开发：

- **视觉风格延续**：
  - **核心色调**：以 Material Design 3 为基础，界面背景以浅灰或白为主（暗色模式自适应），控件与主要强调部分延续原有的**优雅深紫色调（Refined Purple）**。
  - **视觉边角**：控制项（按钮、输入框）使用统一的 `6px` 圆角，卡片使用 `8px` 圆角，悬浮窗或大卡片使用 `12px` 圆角。
- **业务交互组件约束**（根据具体业务场景，选用最合理的交互控件，杜绝不合理的文本输入框）：
  - **时刻/时段输入**：针对时间相关的业务，必须使用时间选择器（`showTimePicker`）或日期选择器（`showDatePicker`），禁止让店员手动输入时间文本。
  - **数值调节**：针对金额、起步时长、价格、加币冷却数等数值参数，应使用带 `+`/`-` 按钮的步进微调器（`StepperNumberField`）或滑动条，防止格式与范围错误。
  - **多选及分类标签**：针对星期、多选配置等逻辑，使用 Material 3 的 `FilterChip`（多选标签芯片）或下拉菜单（`DropdownMenu`），降低用户认知与录入成本。
- **布局自适应**：
  - **`AdminWorkspace`**：响应式整体布局。在窄屏下自动切换为移动端导航栏或抽屉；在宽屏下使用左侧固定侧边栏与主工作区的网格布局。
  - **`AdminSplitPane`**：双栏布局。大屏下左侧为 Master 数据列表，右侧为 Detail 详情区。移动端下，右侧详情区通过底部分页弹窗（Sheet）或独立页面压栈呈现。
  - **`AdminTablePanel`**：统一卡片包装的表格。内置页面标题、操作栏、过滤器、表头以及可滚动的行，并自带 Loading、空数据和错误状态。

---

## 4. 各模块功能细节

### 玩家档案 (`PlayersScreen`)
- **布局**：左侧表格展示玩家概览，右侧展示选中玩家的详细画像。
- **核心数据**：基本属性，已绑定的身份渠道（QQ群、扫码、Aime 物理卡等）。
- **操作流程**：
  - **新建玩家**：弹窗输入显示名及初始参数。
  - **增减资产**：为付费和免费钱包余额提供充值或手动扣减功能，必须输入调整原因。
  - **绑定身份**：下拉选择渠道。UI 上将底层的 `provider` 转换为符合国内店员认知的词汇（例如 `qq` -> `QQ群`，`aime` -> `Aime卡`）。
  - **历史订单与在店流水**：以时间轴展示该玩家过往的所有结账金额、入场渠道和计时时长。

### 资产与礼物 (`AssetsScreen`)
- **布局**：通过三个 Tab 切换管理：`资产定义`、`礼物配置`、`兑换码`。
- **资产定义**：维护全店支持的虚拟货币、道具或卡券，支持新建与归档操作。
- **礼物配置**：支持打包多种资产（如 10元余额 + 5张游戏券），维护可见范围与归档状态。
- **兑换码**：支持输入自定义兑换码，或批量自动生成指定数量的 CDK，提供 CDK 撤销功能。

### 计费配置 (`PricingScreen`)
- **布局**：左侧展示现有计费策略，右侧为可视化规则编辑器。
- **规则编辑器**：
  - 核心参数全部使用时间选择器、日期选择器以及步进数字输入框，防止由于店员录入错误格式导致后台系统解析失败。
- **计费时间轴预览**：
  - 通过“草稿预览”按钮，将当前未保存的表单数据实时发送至后端的预览 API（`/rpc/staff/pricing-timeline/preview`），在界面上直接渲染出 24 小时的分段计费示意图。

### 服务项目与订单 (`ServicesScreen`)
- **布局**：两个 Tab 分别管理 `服务项目` 与 `订单处理`。
- **服务项目`**：列出实物商品（如饮料）或人工收费项目，支持新建和下架（归档）。
- **订单处理**：实时展示玩家的非计时消费清单。支持快捷点击“确认核销”或“取消订单”操作。

### 设备看板 (`DevicesScreen`)
- **布局**：顶部展示在线/离线/故障指标网格，下方展示设备物理列表与指令下发记录。
- **审计日志**：按时序记录每条发送到终端的投币、开门指令的发送状态、响应状态及超时状态。

### 营业报表 (`ReportsScreen`)
- **布局**：顶部为日期范围筛选，下方为统计卡片与两张明细表格。
- **数据汇总**：统计选定日期范围内的总收入、结账总数、总加币数。
- **报表分析**：
  - **结算流水表**：展示每笔结账的玩家、 stay 时长、应收、实收和结算人。
  - **玩家贡献排行**：按累积在店时长和消费贡献对玩家进行排名。

### 员工与系统 (`SystemScreen`)
- **布局**：通过三个 Tab 管理：`店铺设置`、`员工权限`、`接入密钥`。
- **店铺设置**：管理店铺名、系统时区、以及投币冷却时间。
- **员工权限**：管理店员账号。支持新建、编辑姓名 and 角色、启用/禁用、以及重置密码。
- **接入密钥**：用于为其他 Bot 或网关发放 API 令牌。创建的新 Token 密钥仅在生成时弹窗显示一次。

---

## 5. 术语转换与文案规范

为了防止数据库及后端英文术语对店员造成认知障碍，必须在普通 UI 状态下进行本地化翻译：
- 绝对不要直接展示：
  - `provider` / `subject` -> `身份来源` / `外部编号`
  - `session` -> `计时项`
  - `metadata` / `payload` -> `高级详情` / `指令内容`
  - `HH:mm` 等原始格式 -> `时间` 
- 开发者调试信息应放置在折叠卡片中，并标记为 `高级调试信息`。

---

## 6. 测试与验证计划

- **单元测试**：
  - 编写对新 API Models 的 JSON 解析单元测试，确保由 `freezed` 和 `json_serializable` 生成的代码能够正确解析后端传输的 JSON 数据。
- **组件与 Widget 测试**：
  - 确保页面在移动端尺寸和桌面端尺寸下渲染正常。
  - 验证表单选择器交互时不会发生崩溃。
  - 模拟 Mock 客户端，验证点击保存和归档时，向后端发出了正确的 HTTP 方法与 Payload。
