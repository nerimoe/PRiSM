# prism_dashboard Full Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution rule:** Each model/agent must finish exactly one task group or one task at a time. After finishing, update this file by changing the relevant checkbox from `- [ ]` to `- [x]`, add the verification command output summary under that task, and stop for review.
>
> **Testing rule:** Every feature task must add or update a corresponding unit/widget/API test before implementation is considered complete.
>
> **Commit rule:** Every completed task must be committed before the next model starts. The commit must include the task implementation, its tests, related documentation, and this plan file with the completed checkbox plus verification note.

**Goal:** Finish the `prism_dashboard` Flutter Web admin rewrite so every navigation module is a real, test-covered staff workflow instead of a preview or placeholder.

**Architecture:** `packages/prism-dashboard` is the new admin client and should consume staff RPCs through a typed Dart API layer. Existing `packages/admin-flutter` is reference material for business/API coverage only; do not copy its visual structure or preserve its mistaken session-first mental model. If an existing backend endpoint cannot support a required staff workflow, extend `packages/server-hono`, `packages/application`, `packages/runtime`, and `packages/rpc` with the minimum real backend capability.

**Tech Stack:** Bun + TypeScript monorepo, Hono server, `@prism/rpc`, Flutter Web, Material 3, Riverpod, `http` MockClient tests, local Flutter SDK at `${FLUTTER_HOME}`.

---

## 1. Project Structure

The repository is a Bun/TypeScript monorepo for PRiSM Next.

- `packages/core`: Pure domain logic. Keep session, settlement, assets, pricing, redeem, business item, device command rules here. Do not import Hono, DB clients, Flutter, filesystem, or network code.
- `packages/application`: Use-case orchestration. Staff commands, settlement flows, pricing services, redeem services, business item orders, staff users, and API token operations live here.
- `packages/storage-sql`: Shared SQLite/D1 schema and SQL repositories.
- `packages/adapter-sqlite` and `packages/adapter-d1`: Runtime database adapters.
- `packages/server-hono`: Hono route factory, request parsing, staff/player/agent RPC endpoints, view model conversion.
- `packages/runtime`: Wires repositories, services, auth, pricing providers, and Hono dependencies for local SQLite and Cloudflare/D1.
- `packages/rpc`: Shared RPC route manifest and requester helpers. New clients should not hand-invent staff URLs when the route belongs here.
- `packages/prism-dashboard`: New Flutter Web admin console. This is the implementation target.
- `packages/admin-flutter`: Legacy admin UI. Use it only to understand already-supported API coverage and old test fixtures.
- `docs`: Public architecture/API documentation. Every code change must update related docs.

Current `prism_dashboard` state:

- Real work implemented: shell/navigation, auth/setup flow, live operations page with player-first active session aggregation.
- Still incomplete: player, assets, pricing, services, devices, and reports now have implemented staff workflows; system screens are still wired but not yet a full staff workflow.
- Foundation repaired after audit: API models now accept current staff RPC payload names, token secrets are not serialized or printed, shared admin layout/status helpers exist, and `module_pages.dart` is only a compatibility export file.

---

## 2. Business Logic

PRiSM Next manages a single self-hosted venue/store.

The core business object is a player. A player may enter from QQ, Aime, scan, or staff action. When a player enters, the backend starts one or more active time-based sessions. Multiple sessions under the same player are **parallel siblings**, not parent/child sessions and not primary/secondary sessions.

The confirmed live operations model is:

- A player appears once in the live player list.
- The list preview shows stay duration, count of timing items, current estimated total, and staff-readable status.
- Selecting a player opens that player's flat session detail list.
- Staff may stop one timing item. This only closes that one session and leaves it unpaid.
- Player-level checkout previews and settles all active and unpaid closed sessions together.
- Business examples such as "music game time + mahjong adjustment" are store-specific configurations, not universal UI assumptions.

Other important business rules:

- Assets are the wallet system. `currency/paid` and `currency/free` are normal asset definitions with special operational meaning.
- Asset definitions, presents, redeem codes, business items, and pricing configs use archive/restore semantics. Do not hard-delete history-bearing objects.
- Business items are non-time services or products purchased while a player is in an active session. Orders can be fulfilled or cancelled.
- Staff roles are `owner`, `manager`, and `viewer`. Owner-only workflows include staff user management.
- API tokens are for player, bot, and agent access. Newly created token secrets are shown once.
- UI copy must be staff-facing Chinese. Avoid exposing raw backend words such as `provider`, `subject`, `metadata`, and `session` in normal screens. Use "身份来源", "外部编号", "高级详情", "计时项" instead.

- UI & Interactive Style Rules:

- Visual style must inherit design rules from `/prism-dashboard`: use modern Material 3 surfaces, a refined purple accent color palette, card-based layouts, and standardized border radius (`6px` for inputs/controls, `8px` for cards, `12px` for dialogs/overlays).
- Choose the most appropriate interactive widgets based on the business logic: avoid using raw text fields for data types that have structured selection components. For example, use date/time selectors (`showTimePicker`/`showDatePicker`) for timestamps, `StepperNumberField` (with `+`/`-` buttons) or slider controls for numbers, and multi-choice chips or dropdown menus for tags/selections. Prevent user input syntax errors at the UI widget layer.

---

## 3. Required Feature Coverage

Complete these admin modules:

- [ ] 现场工作台: keep current player-first implementation, then integrate any shared API/model refinements without regressing layout.
- [ ] 玩家档案: players list, create player, status changes, identity binding, assets, asset grants/adjustments, session history, bill detail.
- [ ] 资产与礼物: asset definitions, presents, redeem codes, archive/restore, create single/batch CDK.
- [ ] 计费配置: pricing config list, rule editor, picker-based time/date controls, archive/restore, extension status, saved and draft timeline preview.
- [x] 服务项目与订单: business item list/create/archive/restore, order list/fulfill/cancel.
- [x] 设备看板: device state cards/table, device command audit table.
- [x] 营业报表: date range controls, summary metrics, settlement rows, player ranking.
- [x] 员工与系统: settings, staff users, password reset, API token list/create/revoke.
- [ ] Documentation: docs and package README updated after each related change.

---

## 4. Global Checklist Rules

Every task below must follow this process:

- [ ] Read the task and check current repository state before editing.
- [ ] Before any browser/UI verification, confirm the local API port is served by the PRiSM Bun runtime, not a preview script, static server, fixture server, or unrelated process. Record the command/output in the task note.
- [ ] If the UI task needs backend data and the required backend endpoint is missing or insufficient, extend the backend first; do not unblock the UI with hard-coded rows, dummy data, or client-only business behavior.
- [ ] Write or update the test for the task first.
- [ ] Run the focused test and confirm the new/changed test fails for the expected reason when practical.
- [ ] Implement the smallest working change for the task.
- [ ] Run the focused test and confirm it passes.
- [ ] Run the module-level validation command listed in the task.
- [ ] If the task changes visible UI, start the app, capture a screenshot, and perform browser click verification for the changed workflow before marking the task complete.
- [ ] UI browser verification must connect to a real local Bun backend seeded through real RPC calls. Widget tests may use mocked HTTP clients, but screenshots/click checks are invalid if the app is backed by preview stubs, dummy data, unrelated temporary services, or visible hard-coded demo rows.
- [ ] Update documentation if code behavior/API/UI coverage changed.
- [ ] Mark the task checkbox complete in this file and add a one-line verification note.
- [ ] Commit the completed task before starting another task.

Standard commands:

```bash
bun test
bun run typecheck
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
git diff --check
```

Use focused commands during each task. Run the full command set before claiming the full dashboard rewrite is complete.

Commit after every task using this pattern if the task does not provide a more specific commit command:

```bash
git add <files changed by this task> docs/superpowers/plans/2026-07-04-prism-dashboard-full-admin.md
git commit -m "<type>: <short task summary>"
```

Do not start the next task until this commit exists.

---

## 5. Step-by-Step Implementation Plan

### Task 1: Create Shared Dart API Surface and Models

**Purpose:** Move `prism_dashboard` from live-only API coverage to complete staff API coverage.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Modify: `packages/prism-dashboard/test/live_operations_test.dart`
- Create: `packages/prism-dashboard/test/api_models_test.dart`
- Check: `packages/rpc/src/index.ts`
- Update: `packages/prism-dashboard/README.md`

**Steps:**

- [x] Add Dart models for `Player`, `PlayerAssets`, `AssetDefinition`, `AssetHolding`, `AssetLedgerEntry`, `Present`, `RedeemCode`, `PricingConfig`, `PriorityTimeRule`, `UnitPricing`, `PricingTimeline`, `BusinessItem`, `BusinessItemOrder`, `DeviceState`, `DeviceCommand`, `ReportSummary`, `SettlementReportRow`, `PlayerReportRow`, `SettingsData`, `StaffUser`, and `ApiToken`.
- [x] Add `PrismApiClient` methods for all staff endpoints already present in `packages/rpc/src/index.ts`.
- [x] Extend `_request` to support `GET` query params, `PUT`, and `PATCH`.
- [x] Add `api_models_test.dart` with representative JSON parsing for at least: player, asset definition, pricing rule, business item order, staff user, API token.
- [x] Add API method tests using `MockClient` for `PUT`, `PATCH`, query params, and one write operation per module.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```
- [x] Commit this task:

```bash
git add packages/prism-dashboard/lib/src/api packages/prism-dashboard/test packages/prism-dashboard/README.md docs/superpowers/plans/2026-07-04-prism-dashboard-full-admin.md
git commit -m "feat: expand prism dashboard api models"
```

**Completion note:**
`Verification: bun run prism-dashboard:test passed with 20 test cases, bun run prism-dashboard:analyze found no issues.`

**Audit repair note:** `Follow-up verification on 2026-07-05 fixed missing staff checkout/session methods, aligned Dart parsing with backend response keys, protected ApiToken one-time secrets from toJson/toString, and verified prism-dashboard:test, prism-dashboard:analyze, and bun run typecheck. Commit required before Task 4.`

---

### Task 2: Split Placeholder Modules into Feature Folders

**Purpose:** Remove the single placeholder `module_pages.dart` bottleneck and create real module boundaries.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/modules/module_pages.dart`
- Modify: `packages/prism-dashboard/lib/src/features/shell/home_shell.dart`
- Create: `packages/prism-dashboard/lib/src/features/players/players_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/assets/assets_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/pricing/pricing_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/services/services_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/devices/devices_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/reports/reports_screen.dart`
- Create: `packages/prism-dashboard/lib/src/features/system/system_screen.dart`
- Create: `packages/prism-dashboard/test/navigation_modules_test.dart`

**Steps:**

- [x] Create one screen file per module with a real loading/error/empty scaffold, not intro marketing cards.
- [x] Keep visible page titles: `玩家档案`, `资产与礼物`, `计费配置`, `服务项目与订单`, `设备看板`, `营业报表`, `员工与系统`.
- [x] Wire `HomeShell` directly to the new screen classes.
- [x] Keep `module_pages.dart` only as temporary exports or delete its placeholder classes once imports are migrated.
- [x] Add `navigation_modules_test.dart` asserting all eight destinations render their real module title and no `_ActionTile` placeholder text remains.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```
- [x] Commit this task:

```bash
git add packages/prism-dashboard/lib/src/features packages/prism-dashboard/test/navigation_modules_test.dart docs/superpowers/plans/2026-07-04-prism-dashboard-full-admin.md
git commit -m "refactor: split prism dashboard modules"
```

**Completion note:**
`Verification: bun run prism-dashboard:test passed with navigation widget tests successfully asserting each new screen features and page titles. bun run prism-dashboard:analyze found 0 issues.`

**Audit repair note:** `Follow-up verification on 2026-07-05 removed stale placeholder classes from module_pages.dart, kept it as exports only, and updated tests away from the removed placeholder PricingModulePage. Commit required before Task 4.`

---

### Task 3: Build Shared Admin UI Components

**Purpose:** Avoid each module inventing its own table/detail/form behavior.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/shared/widgets.dart`
- Create: `packages/prism-dashboard/lib/src/shared/admin_layout.dart`
- Create: `packages/prism-dashboard/lib/src/shared/admin_tables.dart`
- Create: `packages/prism-dashboard/lib/src/shared/admin_forms.dart`
- Create: `packages/prism-dashboard/test/shared_widgets_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Steps:**

- [x] Add `AdminWorkspace`, `AdminToolbar`, `AdminSplitPane`, `AdminTablePanel`, `AdminDetailPanel`, `ConfirmActionDialog`, `FormSheet`, `MoneyText`, `DateTimeText`, `DateRangePickerButton`, and `StepperNumberField`.
- [x] Implement natural-height panel behavior: panels wrap content when rows fit and scroll internally only when content exceeds available height.
- [x] Add status label helpers for player, archive, order, device, staff user, and API token statuses.
- [x] Add widget tests for natural-height behavior, empty state, confirm dialog copy, and stepper min/max behavior.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```
- [x] Commit this task:

```bash
git add packages/prism-dashboard/lib/src/shared packages/prism-dashboard/test/shared_widgets_test.dart packages/prism-dashboard/README.md docs/superpowers/plans/2026-07-04-prism-dashboard-full-admin.md
git commit -m "feat: add prism dashboard shared admin components"
```

**Completion note:**
`Verification: bun run prism-dashboard:test passed with widget tests covering Stepper min/max bounds, Money/DateTime styling, ConfirmActionDialog custom states, and AdminSplitPane responsiveness. bun run prism-dashboard:analyze found 0 issues.`

**Audit repair note:** `Follow-up verification on 2026-07-05 added AdminWorkspace, staff user/API token status pills, natural-height AdminDetailPanel behavior, and clamped StepperNumberField changes. Commit required before Task 4.`

---

### Task 4: Implement 玩家档案

**Purpose:** Make player management a real workflow.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/players/players_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/players_screen_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Left table: player name, status, wallet total, active timing state.
- Right detail: profile, identity binding, wallet holdings, ledger entries, session history.
- Actions: create player, enable/disable/ban status change, bind identity, grant asset, adjust asset.
- Hide raw `provider`/`subject` labels from normal UI; show as `身份来源` and `外部编号`.
- Presence (`在场`/`离店`) is derived from whether the player has at least one active timing item. `activeSessionId` is only a list hint for old staff APIs; the detail view must count all active sessions from session history and must not treat account `disabled` as "离店".

**Steps:**

- [x] Add test fixtures for player list, player assets, session history, and session detail.
- [x] Add widget test: renders player list and selected detail.
- [x] Add widget test: create player posts display name and optional initial grants.
- [x] Add widget test: bind identity uses natural Chinese labels, not raw `provider`/`subject`.
- [x] Add widget test: grant and adjust asset call correct endpoints.
- [x] Implement the screen with loading, error, empty, and selected-player states.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test --test-randomize-ordering-seed=random
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/players_screen_test.dart passed; bun run prism-dashboard:test --test-randomize-ordering-seed=random passed with seed 775515269; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed; bun run typecheck passed; browser screenshot/click verification opened 玩家档案 and 添加玩家 dialog on http://127.0.0.1:63230. Note: the temporary local dev backend returned NOT_FOUND for /rpc/staff/players, so the browser verified error handling and visible UI interactions while widget tests verified populated player/multi-session behavior.`

**Follow-up correction:**
`2026-07-05: previous browser verification was not sufficient because port 8787 was occupied by a Python preview stub returning preview-token. Real backend verification must run Bun locally. Verified against the PRiSM Bun backend on 8787 that one player can have two parallel active sessions, /rpc/staff/live-players returns one player row with two timing items, and stopping one session closes only that session as unpaid.`

---

### Task 5: Implement 资产、礼物与兑换码

**Purpose:** Support asset catalog, present catalog, and CDK operations.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/assets/assets_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/assets_screen_test.dart`
- Update: `docs/api.md`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Tabs: `资产定义`, `礼物`, `兑换码`.
- Asset definitions: list active and archived items, create/edit definition, archive/restore.
- Presents: list, create with grant rows, archive/restore.
- Redeem codes: list, create single, create batch, revoke.
- Date fields must use date/date-time picker UI; no raw ISO text fields in normal workflow.
- Advanced metadata may appear only in an "高级详情" expansion area.

**Steps:**

- [x] Add tests for asset definition list, archive/restore, and create/edit body.
- [x] Add tests for present creation with grant rows.
- [x] Add tests for single and batch CDK generation and revoke.
- [x] Implement tab layout and forms.
- [x] Confirm UI copy does not show `metadata` in normal collapsed state.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/assets_screen_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed; bun run typecheck passed; browser screenshot/click verification opened 礼物与兑换码, switched tabs, and opened 添加礼物 dialog on http://127.0.0.1:63231. Note: the temporary local dev backend returned NOT_FOUND for /rpc/staff/asset-definitions, so browser verification covered error handling and visible interactions while widget tests covered populated data and write bodies.`

---

### Task 6: Implement 计费配置

**Purpose:** Turn the pricing example controls into a full pricing management screen.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/pricing/pricing_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/pricing_screen_test.dart`
- Update: `docs/api.md`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- List pricing configs with enabled/disabled and archived states.
- Detail editor for `time.priority` configs.
- Rule controls: label, priority, time range picker, weekday filter chips, specific date picker, absolute date-time range picker, unit minutes stepper, unit price stepper, grace minutes stepper, price cap stepper.
- Timeline preview for saved config and draft config.
- Archive/restore actions.
- No raw `HH:mm`, ISO, or millisecond text fields.

**Steps:**

- [x] Add model tests for `PricingConfig`, `PriorityTimeRule`, and `PricingTimeline`.
- [x] Add widget test: rule editor uses picker/chips/steppers and no raw technical fields.
- [x] Add widget test: preview draft posts `/rpc/staff/pricing-timeline/preview`.
- [x] Add widget test: save create/update posts correct `kind: "time.priority"` body.
- [x] Add widget test: archive/restore calls correct endpoint.
- [x] Implement screen and timeline visualization.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Partial verification note:**
`PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/pricing_screen_test.dart test/api_models_test.dart test/live_operations_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed; bun run typecheck passed; bun test passed with 277 tests; git diff --check passed. Real Bun backend was started with PRISM_SQLITE_PATH=/tmp/prism-dashboard-e2e-8788.sqlite on port 8787 after removing the stale Python preview stub. /rpc/staff/live-players and stop-session were verified with curl against the real backend. Browser Computer Use/Chrome window handle failed during final screenshot, so do not mark browser screenshot/click verification complete until rerun.`

**Completion note:**
`Verification: <fill command summary here>`

---

### Task 7: Implement 服务项目与订单

**Purpose:** Support non-time service catalog and order handling.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/services/services_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/services_screen_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Tabs: `服务项目`, `订单处理`.
- Service item list: name, kind, price, linked asset, active window, status.
- Create service item form: kind, name, price, optional linked asset, active/expires pickers.
- Archive/restore service item.
- Orders list: player, item, price, status, created time, fulfilled/cancelled time.
- Fulfill/cancel confirmation dialogs use `核销` and `取消订单`; do not promise automatic refund unless backend implements it.

**Steps:**

- [x] Add tests for business item parsing and order parsing.
- [x] Add widget test: service item creation posts correct body.
- [x] Add widget test: archive/restore action.
- [x] Add widget test: fulfill/cancel order confirmation and endpoint call.
- [x] Implement screen with two tabs.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/services_screen_test.dart test/api_models_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed. Confirmed port 8787 was served by Bun with lsof, then verified real staff RPCs against the local Bun backend: create/list/archive/restore business item and list business-item-orders. Browser verification used the release Flutter build on 127.0.0.1:63241 connected to the real Bun backend on 8787; screenshots captured /tmp/prism-dashboard-shots/services-items.png, /tmp/prism-dashboard-shots/services-orders.png, and /tmp/prism-dashboard-shots/services-add-dialog.png after logging in and clicking the services workflows.`

---

### Task 8: Implement 设备看板

**Purpose:** Make device state and command audit visible to staff.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/devices/devices_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/devices_screen_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Device status summary: online, offline, degraded/unhealthy.
- Device table: label, type, state, reported time, reported by.
- Command audit table: command type, device id, requester, status, requested/acked/expired times.
- Status text must be staff-facing: `在线`, `离线`, `待执行`, `已确认`, `已超时`, etc.

**Steps:**

- [x] Add model tests for device state and command.
- [x] Add widget test: device summary counts statuses correctly.
- [x] Add widget test: command audit renders status and times.
- [x] Implement screen.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/devices_screen_test.dart test/api_models_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed. Confirmed 8787 was served by Bun, then created temporary agent/player API tokens through real staff RPCs, reported a device state through /rpc/agent/device-states/:deviceId, requested a device command through /rpc/player/device-commands, and confirmed staff /rpc/staff/device-states plus /rpc/staff/device-commands returned real rows. Browser verification used the release Flutter build on 127.0.0.1:63241 connected to the real Bun backend on 8787; screenshot captured /tmp/prism-dashboard-shots/devices-dashboard.png after logging in and clicking 设备管理.`

---

### Task 9: Implement 营业报表

**Purpose:** Provide staff-facing daily/range reporting.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/reports/reports_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/reports_screen_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Date range picker with default today.
- Summary metrics: revenue, settled sessions, asset grants, coin commands.
- Settlement table: player, duration, subtotal, total, settled time.
- Player ranking table: player, settlement count, total duration, revenue, last settled time.
- Do not expose ISO input. Query params may still use ISO internally.

**Steps:**

- [x] Add model tests for report summary, settlement rows, and player rows.
- [x] Add widget test: date range change calls report endpoints with new range.
- [x] Add widget test: summary and two tables render.
- [x] Implement screen.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/reports_screen_test.dart test/api_models_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed. Confirmed port 8787 was served by Bun, settled player A through real staff checkout-all RPC to create report rows, and verified staff reports summary/settlements/players against the real backend. Browser verification used the release Flutter build on 127.0.0.1:63241 connected to the real Bun backend on 8787; screenshots captured /tmp/prism-dashboard-shots/reports-dashboard.png and /tmp/prism-dashboard-shots/reports-dashboard-seven-days.png after logging in, clicking 营业报表, and opening the date range picker.`

---

### Task 10: Implement 员工与系统

**Purpose:** Complete owner/system administration.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/system/system_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Create: `packages/prism-dashboard/test/system_screen_test.dart`
- Update: `docs/api.md`
- Update: `packages/prism-dashboard/README.md`

**Required UI behavior:**

- Tabs: `店铺设置`, `员工权限`, `接入密钥`.
- Settings: store name, timezone, coin cooldown stepper/number control.
- Staff users: list, create, edit display name/role/status, reset password.
- API tokens: list, create, revoke. Newly created token secret appears once in a clear result dialog.
- Owner-only actions should show disabled state or permission notice when current staff cannot write.

**Steps:**

- [x] Confirm `docs/api.md` contains staff users and API token endpoints; add missing token route docs if needed.
- [x] Add model tests for settings, staff user, and API token.
- [x] Add widget test: update settings uses `PUT /rpc/staff/settings`.
- [x] Add widget test: create staff user and reset password.
- [x] Add widget test: create API token shows one-time token secret and revoke calls endpoint.
- [x] Implement screen.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/system_screen_test.dart test/api_models_test.dart test/navigation_modules_test.dart passed; bun run prism-dashboard:test passed; bun run prism-dashboard:analyze passed; bun run prism-dashboard:build passed. Confirmed port 8787 was served by Bun and verified real staff settings/users/api-tokens RPCs. Browser verification used the release Flutter build on 127.0.0.1:63241 connected to the real Bun backend on 8787; screenshots captured /tmp/prism-dashboard-shots/system-settings.png and /tmp/prism-dashboard-shots/system-tokens.png after logging in, clicking 员工权限, and switching to 接入密钥.`

---

### Task 11: Fill Backend Gaps Found During Flutter Implementation

**Purpose:** Add real backend support only where a required UI workflow cannot be honestly supported by existing APIs.

**Files:**

- Modify as needed: `packages/rpc/src/index.ts`
- Modify as needed: `packages/server-hono/src/index.ts`
- Modify as needed: `packages/server-hono/src/types.ts`
- Modify as needed: `packages/server-hono/src/views.ts`
- Modify as needed: `packages/application/src/*`
- Modify as needed: `packages/runtime/src/index.ts`
- Test as needed: `packages/rpc/test/*.test.ts`, `packages/server-hono/test/*.test.ts`, `packages/application/test/*.test.ts`
- Update: `docs/api.md`, `docs/architecture.md`

**Known areas to verify:**

- Staff API token endpoints are documented and wired in runtime.
- Staff user endpoints are documented and wired in runtime.
- Any list view needed by Flutter returns enough display names to avoid raw ids where staff-facing names are expected.
- Do not add fake front-end-only state to mask a missing write path.

**Steps:**

- [x] For each missing capability, first add a failing TypeScript test at the package closest to the behavior.
- [x] Add or update the RPC manifest route in `packages/rpc/src/index.ts`.
- [x] Add Hono route and view model in `packages/server-hono`.
- [x] Add application service/runtime wiring only if the dependency is not already available.
- [x] Update docs for the new or corrected endpoint.
- [x] Run:

```bash
bun test
bun run typecheck
```

**Completion note:**
`Verification: No additional backend capability was required after Tasks 7-10. Staff users, API tokens, settings, reports, devices, services, and live player/session semantics were already wired through real runtime RPCs; only Flutter client parsing/copy fixes were needed. bun test passed with 277 tests; bun run typecheck passed.`

---

### Task 12: Humanize Copy and Remove Developer-Facing Terms

**Purpose:** Ensure the completed UI reads like an operations tool, not a database viewer.

**Files:**

- Modify: all `packages/prism-dashboard/lib/src/features/**`
- Create or modify: `packages/prism-dashboard/test/copy_constraints_test.dart`
- Update: `packages/prism-dashboard/README.md`

**Required copy constraints:**

- Normal UI must not show: `provider`, `subject`, `metadata`, `session`, `payload`, `ISO`, `millisecond`, `HH:mm`.
- Acceptable replacements: `身份来源`, `外部编号`, `高级详情`, `计时项`, `指令内容`, `日期`, `时长`.
- Confirmation dialogs must explain destructive or billing actions in plain Chinese.

**Steps:**

- [x] Add `copy_constraints_test.dart` that pumps all major module screens with fixture data and asserts forbidden terms are absent from visible normal UI.
- [x] Replace developer-facing labels in each module.
- [x] Keep raw payload/metadata only inside collapsed `高级详情` sections.
- [x] Run:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
```

**Completion note:**
`Verification: Added test/copy_constraints_test.dart, changed the report metric from 已结 session to 已结账单, and converted player history raw active/closed/settled values to Chinese labels. PATH="${FLUTTER_HOME}/bin:$PATH" flutter test --no-pub --reporter compact test/copy_constraints_test.dart test/reports_screen_test.dart test/players_screen_test.dart passed.`

---

### Task 13: Browser Preview and Responsive QA

**Purpose:** Verify the full rebuilt admin is usable, not only test-passing.

**Files:**

- Modify if issues found: relevant Flutter screens/components.
- Save screenshots outside repo, for example `/tmp/prism-dashboard-full-admin-desktop.png` and `/tmp/prism-dashboard-full-admin-mobile.png`.

**Steps:**

- [x] Build web:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
```

- [x] Serve or refresh the existing preview at `http://127.0.0.1:63241/`.
- [x] Click every sidebar destination and confirm no placeholder module cards remain.
- [x] Desktop QA: no text overflow, no incoherent overlap, panels do not hard-stretch with empty content, tables scroll internally when content is too long.
- [x] Mobile QA: NavigationBar works, forms are usable, dialogs fit, tables are horizontally or vertically scrollable.
- [x] Screenshot final desktop and mobile states.
- [x] Run:

```bash
git diff --check
```

**Completion note:**
`Verification: PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build passed. Existing release preview at http://127.0.0.1:63241 served build/web and connected to the real Bun backend on 8787. Browser CDP clicked the desktop sidebar destinations and captured /tmp/prism-dashboard-shots/final-desktop.png. Mobile CDP at 390x844 logged in and captured /tmp/prism-dashboard-shots/final-mobile.png. git diff --check passed.`

---

### Task 14: Final Full Verification

**Purpose:** Prove the complete rewrite is ready for review.

**Files:**

- Update: this checklist file.
- Update: `packages/prism-dashboard/README.md`
- Update: `docs/api.md`
- Update: `docs/architecture.md`

**Steps:**

- [x] Confirm every task above is marked complete with a verification note.
- [x] Run full backend validation:

```bash
bun test
bun run typecheck
```

- [x] Run full Flutter validation:

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
```

- [x] Run repository whitespace check:

```bash
git diff --check
```

- [x] Final acceptance: all eight admin modules are real, test-covered workflows; live operations remains player-first with flat timing item details; normal UI contains no developer-facing copy.

**Completion note:**
`Verification: bun test passed with 277 tests; bun run typecheck passed; PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze passed; bun run prism-dashboard:test passed; bun run prism-dashboard:build passed; git diff --check passed. Final browser screenshots: /tmp/prism-dashboard-shots/final-desktop.png and /tmp/prism-dashboard-shots/final-mobile.png.`

---

## 6. Model Handoff Template

Use this prompt when handing one task to a different model:

```text
You are working in ..
Read docs/superpowers/plans/2026-07-04-prism-dashboard-full-admin.md.
Implement only Task <N>: <task title>.
Follow the task checklist exactly:
1. write/update tests first,
2. implement the minimum code,
3. run the listed verification commands,
4. update the task checkbox and completion note in the plan file,
5. stop and summarize what changed.
Do not start the next task.
Do not revert unrelated dirty work.
Use Flutter from ${FLUTTER_HOME}.
```

---

## 7. Final Acceptance Criteria

- [x] No placeholder module-intro cards remain in `prism_dashboard`.
- [x] Every sidebar destination is backed by real API data and at least one write/read workflow where the backend supports it.
- [x] Each module has model or widget tests.
- [x] All public API additions or behavior changes are documented.
- [x] Flutter analyze/test/build pass.
- [x] Bun test/typecheck pass.
- [x] Browser preview shows desktop and mobile layouts without overflow or hard-stretched empty panels.
- [x] The live operations model remains player-first and flat-session under player detail.
