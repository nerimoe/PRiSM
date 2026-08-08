# PRiSM Next Integration and Machine API Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution rule:** Each worker must finish exactly one task at a time. After finishing, update this file by changing the relevant checkbox from `- [ ]` to `- [x]`, add the verification command output summary under that task, and stop for review.
>
> **Testing rule:** Every behavior change must include focused tests first. Every visible UI change must also be run locally and verified with a screenshot plus at least one browser click check.
>
> **Commit rule:** Every completed task must be committed before the next model starts. The commit must include implementation, tests, docs, and this plan file with the completed checkbox plus verification note.

**Goal:** Replace the current awkward `bot_token + player_token + staff_token + generated device role` split with an API model that matches the real PRiSM business: trusted bot/integration entrypoints operate by external identity, future player Web sessions operate as the player themselves, staff operates as staff, and machine software receives machine commands through WebSocket while HA remains a separate direct-control executor.

**Architecture:** Keep PRiSM Next's stronger internal model of stable `playerId` plus structured identities, but expose an ergonomic integration facade similar to prism-neo's old `QQ:123456` flow. Device operations become business-level `device actions` accepted from bot/Web/staff; execution is dispatched internally to Home Assistant direct calls or game-machine WebSocket delivery. Because the project is not in production yet, delete generated device polling terminology and endpoints instead of preserving a compatibility layer.

**Tech Stack:** Bun + TypeScript monorepo, Hono server, SQLite/D1 SQL storage, `@prism/rpc`, `@prism/bot-client`, AstrBot Python plugin, Flutter Web dashboard, Material 3, local Flutter SDK at `${FLUTTER_HOME}`.

---

## 1. Current Diagnosis

### 1.1 prism-neo behavior to preserve

The old project at `../prism-neo` allowed bot code to operate directly by external identity:

```http
POST /api/users/QQ:123456/login
GET  /api/users/QQ:123456/wallet
POST /api/users/QQ:123456/logout
POST /api/users/QQ:123456/redeem
POST /api/machine/power
POST /api/remote/:alias/coin
POST /api/remote/:alias/aime
```

`src/modules/user/repo.ts` had one central resolver:

```ts
buildUserWhere("QQ:123456")
```

which mapped the external identity to the internal user through `Bind`.

This was operationally convenient:

- The bot knew a QQ user id and could immediately call login, logout, wallet, billing, redeem, coin, and Aime commands.
- The bot did not have to know `playerId` before starting a player action.
- The backend remained the business judge for whether the user was registered, in session, eligible to use a machine, or allowed to receive device operations.

The weakness was not that `TYPE:ID` cannot support Telegram, Aime, WeChat, or scan identities. It can. The weakness was that the old system placed identity parsing in a URL string, had weak route authentication, and mixed admin/player/bot authority too casually.

### 1.2 prism-next behavior that currently feels wrong

Current PRiSM Next generated roles to remove or replace:

```ts
PrincipalRole = "player" | "staff" | "bot" | "agent"
ApiTokenRole = "player" | "bot" | "agent"
```

Current bot flow:

1. `bot_token` calls `/rpc/bot/identities/resolve`.
2. `player_token` plus `X-PRiSM-Player-Id` calls `/rpc/player/*`.
3. `staff_token` is required for auto-register, binding identity, and stopping a single Mahjong overlay session.

This is too much coupling for an AstrBot/Koishi-style shop entrance:

- A trusted bot should not need three unrelated credentials for one player command.
- `player_token + X-PRiSM-Player-Id` is not safe as a public player Web API. If exposed to a browser, any user who learns another `playerId` could act as that player.
- The current dashboard token creation dialog only exposes the generated device role and `player`, even though backend storage supports `bot`.
- The generated device role is an AI-created abstraction that does not match the project language. The real actors are machine software, Home Assistant, and shop integrations.

### 1.3 Real target deployment

The intended deployment is:

- PRiSM backend is cloud deployed.
- Home Assistant is cloud reachable and is used for power, air conditioner, and possibly other facility hardware.
- Coin and Aime commands are game-machine software functions. They should move from polling to WebSocket because polling is not stable enough.
- Bot receives commands from users, asks PRiSM backend to perform player or machine actions, and the backend decides whether the user state permits the action.

Therefore:

- Bot should call integration APIs, not low-level machine delivery APIs.
- Web player UI should call player-session APIs, not global `player_token` APIs.
- Dashboard should call staff APIs.
- Machine software should authenticate as a machine and maintain a WebSocket channel.
- Home Assistant should remain a direct executor, separate from game-machine WebSocket execution.

---

## 2. Target Model

### 2.1 Principal types

Use these names as the durable architecture language:

```text
staff session
  Admin/dashboard user session.
  Can manage players, assets, pricing, devices, integrations, and overrides.

integration token
  Trusted shop entrypoint such as AstrBot, Koishi, or a store-owned service.
  Can act by external identity after backend rules check the action.

player session
  Future real player Web login.
  Bound to exactly one playerId and must never accept X-PRiSM-Player-Id from the browser.

machine token
  Game machine software credential.
  Used for WebSocket connection, heartbeat, command delivery, ACK/fail, and capability reporting.

no legacy compatibility
  The project is not in production yet. Replace generated role names and routes in-place instead of keeping aliases, deprecation warnings, or dual terminology.
```

### 2.2 External identity format

Use structured identity in new APIs:

```json
{
  "provider": "qq",
  "subject": "123456"
}
```

Also support the old shorthand where useful:

```text
QQ:123456
aime:0111222333
telegram:987654
```

The shorthand must be parsed once in a shared helper and converted to the structured format. Do not let every route split strings manually.

### 2.3 Integration player actions

New integration APIs should let bot call one backend action with one integration token:

```http
POST /rpc/integration/players/by-identity/resolve
POST /rpc/integration/players/by-identity/register
POST /rpc/integration/players/by-identity/session/start
POST /rpc/integration/players/by-identity/checkout/preview
POST /rpc/integration/players/by-identity/checkout/confirm
POST /rpc/integration/players/by-identity/wallet
POST /rpc/integration/players/by-identity/assets
POST /rpc/integration/players/by-identity/history
POST /rpc/integration/players/by-identity/redeem
POST /rpc/integration/players/by-identity/device-actions
```

Read-like operations use `POST` because the identity object and optional auto-register flags are request bodies. This is acceptable under `/rpc`.

Standard request body:

```json
{
  "identity": {
    "provider": "qq",
    "subject": "123456"
  },
  "autoRegister": true,
  "displayName": "QQ 123456"
}
```

Device action body:

```json
{
  "identity": {
    "provider": "qq",
    "subject": "123456"
  },
  "autoRegister": false,
  "target": {
    "kind": "game_machine",
    "id": "maimai-dx-1"
  },
  "action": {
    "type": "coin",
    "payload": {
      "count": 1
    }
  }
}
```

### 2.4 Player Web actions

Future player Web must not use the current global `player_token`.

Target API:

```http
POST /rpc/player-auth/login/by-identity
POST /rpc/player-auth/logout
GET  /rpc/player/me
POST /rpc/player/me/session/start
POST /rpc/player/me/checkout/preview
POST /rpc/player/me/checkout/confirm
POST /rpc/player/me/device-actions
POST /rpc/player/me/redeem
```

The authenticated player session token contains or resolves to one playerId. Browser requests never send arbitrary `X-PRiSM-Player-Id`.

### 2.5 Device action model

Use business-level device actions at the API boundary:

```text
facility device
  Store facilities: power, AC, light, door.
  Usually executed by Home Assistant or another direct HTTP/cloud executor.

game machine
  Game-machine software capabilities: coin, Aime scan, reader simulation, future machine-specific commands.
  Executed by machine WebSocket channel.
```

Do not expose the generated device-role name in bot-facing or staff-facing copy. Use:

```text
机器接入
机器软件
机器通道
机器指令
设施设备
游戏机器
```

Internal execution split:

```text
DeviceActionService
  Resolves actor, checks player/session/status/cooldown/device rules, records audit.

HomeAssistantExecutor
  Executes facility device actions directly against HA.

MachineWebSocketExecutor
  Sends game-machine commands through WebSocket and updates delivery status.
```

### 2.6 Dashboard token copy

The "新建接入密钥" dialog must expose at least:

```text
机器人/店内入口 -> integration token
机器软件接入   -> machine token
玩家登录       -> player session, created through player auth instead of API token creation
```

Do not create or display generated device roles. Do not call machine software "设备接入" if that makes staff think HA and Aime/coin are the same thing.

---

## 3. Files and Ownership Map

### 3.1 Core/domain

- Modify: `packages/core/src/storage-ports.ts`
  - Replace generated API token role types with `integration` and `machine`.
  - Add new device action and machine connection types if kept in core.
- Modify: `packages/core/src/device-command.ts`
  - Evolve from generic pending command to `DeviceAction`.
  - Keep status transitions pure and tested.
- Create: `packages/core/src/identity.ts`
  - Shared parser for `{ provider, subject }` and `TYPE:subject`.
- Test: `packages/core/test/device-command.test.ts`
- Create: `packages/core/test/identity.test.ts`

### 3.2 Application/use cases

- Modify/Create: `packages/application/src/integration.ts`
  - Orchestrate integration identity resolution, optional registration, player actions, and device actions.
- Modify: `packages/application/src/player-commands.ts`
  - Reuse existing session/device command rules instead of duplicating them.
- Modify/Create: `packages/application/src/device-actions.ts`
  - Central business rule layer for device actions.
- Modify/Create: `packages/application/src/machine-connections.ts`
  - Manage WebSocket registration, heartbeat, capabilities, ACK/fail.
- Modify: `packages/application/src/agent-commands.ts`
  - Rename or delete the generated device polling service; new code must use machine naming.
- Test:
  - `packages/application/test/integration.test.ts`
  - `packages/application/test/device-actions.test.ts`
  - `packages/application/test/machine-connections.test.ts`

### 3.3 Storage

- Modify: `packages/storage-sql/src/index.ts`
  - Extend `api_tokens.role` check if new roles are added.
  - Add tables/columns for player sessions, machine credentials, machine connections, command delivery if needed.
- Modify: `packages/storage-sql/src/repositories.ts`
  - Add repositories for identity resolution reuse, integration permissions, player sessions, machine commands.
- Add D1 migration under `migrations/`
  - Must be compatible with existing local SQLite and D1.
- Test storage through existing application/runtime tests.

### 3.4 Server/runtime/RPC

- Modify: `packages/server-hono/src/auth.ts`
  - Authenticate integration token and machine token distinctly.
  - Remove generated device-role authentication paths once replacement routes exist.
- Modify: `packages/server-hono/src/types.ts`
  - Add principal types, integration command interfaces, machine WebSocket dependencies.
- Modify: `packages/server-hono/src/index.ts`
  - Add `/rpc/integration/*`.
  - Add `/rpc/player-auth/*` when player Web auth is implemented.
  - Add `/rpc/machine/ws` or equivalent WebSocket route.
  - Remove generated bot/player/device polling routes after their replacements land in the same milestone.
- Modify: `packages/runtime/src/index.ts`
  - Wire new services, repositories, executors, auth.
- Modify: `packages/runtime/src/serve.ts`
  - If Bun WebSocket upgrade is needed, wire it here or in runtime app creation.
- Modify: `packages/rpc/src/index.ts`
  - Add manifest entries for integration, player-auth, and machine APIs.
- Test:
  - `packages/rpc/test/requester.test.ts`
  - new Hono route tests if the repo has or adds a server route test harness.

### 3.5 Clients

- Modify: `packages/bot-client/src/index.ts`
  - Add integration-token-only methods.
  - Remove the old `botToken + playerToken + staffToken` normal flow.
- Test: `packages/bot-client/test/index.test.ts`
- Modify external repo: `packages/plugin-prism-next-astrbot`
  - Update `prism_astrbot/client.py`, `config.py`, `handlers.py`, `_conf_schema.json`, `README.md`, and tests.
  - Replace `bot_token/player_token/staff_token` normal flow with `integration_token`.

### 3.6 Dashboard

- Modify: `packages/prism-dashboard/lib/src/features/system/system_screen.dart`
  - Add "机器人/店内入口" token type immediately.
  - Remove generated device-role copy and expose "机器软件接入".
- Modify: `packages/prism-dashboard/lib/src/features/devices/devices_screen.dart`
  - Split facility devices and game machines.
  - Show WebSocket online status, capabilities, last heartbeat, recent commands.
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
  - Add new staff/admin device/machine endpoints when backend exists.
- Modify tests:
  - `packages/prism-dashboard/test/system_screen_test.dart`
  - `packages/prism-dashboard/test/devices_screen_test.dart`

### 3.7 Documentation

- Update: `docs/api.md`
- Update: `docs/architecture.md`
- Rename/update: `docs/bot-agent.md` -> `docs/integrations-and-machines.md`
- Update: `docs/deployment.md`
- Update: `docs/extensions.md`
- Update: `packages/prism-dashboard/README.md`
- Update external plugin README: `packages/plugin-prism-next-astrbot/README.md`
- Keep this plan updated after each completed task.

---

## 4. Global Implementation Rules

- [x] Do not preserve generated bot/player/device polling endpoints as public compatibility APIs. Replace them in focused tasks, update tests, and remove the old routes before the milestone is considered complete.
- [ ] New bot-facing work must use the term `integration` in code and "机器人/店内入口" in staff-facing Chinese copy.
- [ ] New machine-facing work must use the term `machine`, never the generated device-role name.
- [ ] New player Web work must not trust `X-PRiSM-Player-Id` from browsers.
- [ ] Bot/integration APIs must accept structured identity and may also accept `TYPE:subject` shorthand through a shared parser because that is an intentional prism-neo ergonomic feature, not a compatibility crutch.
- [ ] Backend must own machine operation eligibility checks. Bot and Web clients may display errors but must not reimplement business rules.
- [ ] HA/direct facility control and game-machine WebSocket execution are separate executors behind the same business action service.
- [ ] Every task must include focused tests, documentation updates, `git diff --check`, and a commit.
- [ ] Every visible UI task must include a screenshot path and a browser click verification note in this file.

Standard verification commands:

```bash
bun test
bun run typecheck
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
git diff --check
```

External AstrBot verification:

```bash
cd "packages/plugin-prism-next-astrbot"
python3 tests/test_handlers.py
python tests/test_astrbot_import.py
python -m py_compile main.py prism_astrbot/__init__.py prism_astrbot/config.py prism_astrbot/handlers.py prism_astrbot/client.py tests/test_handlers.py tests/test_astrbot_import.py
```

---

## 5. Step-by-Step Plan

### Task 1: Replace Dashboard Token Type UI With Business Roles

**Why:** Staff should create the credentials that actually exist in the business: one for bot/store integrations and one for machine software. The generated device role and the internal player API token should not be presented as normal setup choices.

**Dependency:** If the backend/storage role replacement has not landed yet, complete Task 2 first. This UI must not ship before the backend accepts `integration` and `machine`.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/system/system_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Modify generated Dart model files for the `ApiToken.role` default.
- Add: `packages/prism-dashboard/lib/src/shared/token_role_labels.dart`
- Modify: `packages/prism-dashboard/test/system_screen_test.dart`
- Modify: `packages/prism-dashboard/test/api_models_test.dart`
- Modify: `packages/prism-dashboard/README.md`
- Update: `docs/api.md`

**How:**

- [x] Change the create-token dialog default to `integration`.
- [x] Add dropdown items:

```dart
DropdownMenuItem(value: 'integration', child: Text('机器人/店内入口'))
DropdownMenuItem(value: 'machine', child: Text('机器软件接入'))
```

- [x] Remove `player` from the token creation dropdown. Player Web login is handled by player sessions in Task 12, not by manually creating shared player API tokens.
- [x] Update `_tokenRoleLabel`:

```dart
String _tokenRoleLabel(String role) => switch (role) {
  'integration' => '机器人/店内入口',
  'machine' => '机器软件接入',
  'player_session' => '玩家登录',
  _ => '外部接入',
};
```

**Tests:**

- [x] Update `system_screen_test.dart` so creating an integration token posts:

```json
{"label":"机器人验证","role":"integration"}
```

- [x] Assert the UI contains `机器人/店内入口` and `机器软件接入`.
- [x] Assert the token creation dropdown does not show `设备接入`, the generated device role label, or `玩家接口`.

**Verification:**

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "creates API token"
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
git diff --check
```

**Browser check:**

- [x] Start backend and dashboard.
- [x] Open `http://localhost:63241`.
- [x] Click `员工与系统` -> `新建接入密钥`.
- [x] Screenshot dropdown showing `机器人/店内入口`.

**Docs:**

- [x] Update `docs/api.md` API token role table to include only `integration` and `machine` for created API tokens.
- [x] Update `packages/prism-dashboard/README.md` token creation wording.

**Commit:**

```bash
git add packages/prism-dashboard/lib/src/features/system/system_screen.dart packages/prism-dashboard/lib/src/api/api_client.dart packages/prism-dashboard/lib/src/api/models.dart packages/prism-dashboard/lib/src/api/models.freezed.dart packages/prism-dashboard/lib/src/api/models.g.dart packages/prism-dashboard/test/system_screen_test.dart packages/prism-dashboard/test/api_models_test.dart docs/api.md packages/prism-dashboard/README.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "fix: expose integration and machine tokens"
```

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Red test first:
  - `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "creates integration API token"` failed because the old UI did not show `机器软件接入`.
  - `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "createApiToken defaults"` failed because the API client still posted `role: "player"`.
- Focused green tests: `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "creates API token|createApiToken defaults"`: 2 pass, 0 fail.
- Plan command: `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "creates API token"`: 1 pass, 0 fail.
- Full dashboard suite: `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test`: 86 pass, 0 fail.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze`: no issues found.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build`: built `packages/prism-dashboard/build/web`.
- `git diff --check`: passed.
- Browser click verification: backend already listening on `http://localhost:8787`; dashboard served current build at `http://localhost:63241`; Playwright launched local Chrome, logged in as local owner, clicked `员工与系统` -> `接入密钥` -> `新建密钥`, opened the role dropdown, and saved screenshot `/tmp/prism-dashboard-task1/create-key-dropdown-open.png`.

---

### Task 2: Replace Generated Token Roles

**Why:** The bot should be a trusted integration entrypoint, machine software should authenticate as a machine, and there is no production need to keep the generated token role model.

**Files:**

- Modify: `packages/core/src/storage-ports.ts`
- Modify: `packages/storage-sql/src/index.ts`
- Modify: `packages/storage-sql/src/repositories.ts`
- Add migration: `migrations/0003_integration_machine_api_tokens.sql`
- Modify: `packages/server-hono/src/types.ts`
- Modify: `packages/server-hono/src/auth.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/application/src/setup.ts`
- Modify tests:
  - `packages/application/test/setup.test.ts`
  - `packages/application/test/staff-api-tokens.test.ts`

**How:**

- [x] Replace generated API token roles with:

```text
integration, machine
```

- [x] Add an explicit `player_session` principal type for Task 12, but do not allow staff to create player API tokens from the access-key dialog.
- [x] Treat `integration` as the only integration principal during authentication.
- [x] Treat `machine` as the only machine principal during authentication.
- [x] Update local SQLite and D1 schema constraints in-place because no production database needs compatibility.
- [x] Setup should create these default access keys for fresh local/dev setup:

```text
机器人/店内入口 API
机器软件接入 API
```

If any generated-role rows exist in a developer database, the migration may either delete them or rewrite them to the new role names. The implementation must document which choice it uses.

**Tests:**

- [x] `staff-api-tokens.test.ts`: can create `integration` and `machine` tokens.
- [x] `staff-api-tokens.test.ts`: rejects generated role names and rejects manually-created player API tokens.
- [x] `setup.test.ts`: fresh setup returns labels for integration and machine tokens.
- [x] Add auth-focused test if a route test harness exists. Otherwise cover through Task 3 route tests.

**Verification:**

```bash
bun test packages/application/test/setup.test.ts packages/application/test/staff-api-tokens.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/api.md`: document the final token roles without legacy aliases.
- [x] `docs/architecture.md`: document principal model.

**Commit:**

```bash
git add packages/core packages/storage-sql migrations packages/server-hono packages/runtime packages/application docs/api.md docs/architecture.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "feat: add integration and machine token roles"
```

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- `bun test packages/application/test/setup.test.ts packages/application/test/staff-api-tokens.test.ts`: 5 pass, 0 fail.
- Extra focused coverage: `bun test packages/application/test/setup.test.ts packages/application/test/staff-api-tokens.test.ts packages/storage-sql/test/schema.test.ts packages/server-hono/test/app.test.ts`: 76 pass, 0 fail.
- Full backend suite: `bun test`: 289 pass, 0 fail.
- `bun run typecheck`: passed.
- `git diff --check`: passed.

---

### Task 3: Add Shared Identity Parser and Resolver Service

**Why:** New APIs should preserve prism-neo's convenience without reintroducing ad hoc `TYPE:ID` parsing in every route.

**Files:**

- Create: `packages/core/src/identity.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/identity.test.ts`
- Modify: `packages/application/src/staff-players.ts` if shared types are needed.

**How:**

- [x] Implement:

```ts
export type ExternalIdentity = {
  provider: string;
  subject: string;
};

export function normalizeExternalIdentity(input: ExternalIdentity): ExternalIdentity;

export function parseIdentityKey(input: string): ExternalIdentity;

export function externalIdentityKey(input: ExternalIdentity): string;
```

- [x] Rules:
  - Trim provider and subject.
  - Lowercase provider for structured inputs.
  - Accept intentional shorthand `QQ:123456`, `qq:123456`, `AIME:abc`.
  - Preserve colons inside subject after the first colon.
  - Throw `PrismDomainError` with code `INVALID_EXTERNAL_IDENTITY` for empty provider/subject or missing separator in shorthand.

**Tests:**

- [x] `parseIdentityKey("QQ:123456")` returns `{ provider: "qq", subject: "123456" }`.
- [x] `parseIdentityKey("telegram:abc:def")` preserves subject `abc:def`.
- [x] invalid strings fail with `INVALID_EXTERNAL_IDENTITY`.

**Verification:**

```bash
bun test packages/core/test/identity.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/api.md`: define structured identity and `TYPE:subject` shorthand.

**Commit:**

```bash
git add packages/core/src/identity.ts packages/core/src/index.ts packages/core/test/identity.test.ts docs/api.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "feat: add external identity parser"
```

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Red test first: `bun test packages/core/test/identity.test.ts` failed because `normalizeExternalIdentity` was not exported yet.
- Green test: `bun test packages/core/test/identity.test.ts`: 5 pass, 0 fail.
- Full backend suite: `bun test`: 294 pass, 0 fail.
- `bun run typecheck`: passed.
- `git diff --check`: passed.

---

### Task 4: Implement Integration Player Actions by Identity

**Why:** AstrBot should be able to say "QQ 123456 starts session" or "QQ 123456 previews checkout" with one integration token and no manual `playerId` token juggling.

**Files:**

- Create: `packages/application/src/integration.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/server-hono/src/types.ts`
- Modify: `packages/server-hono/src/index.ts`
- Modify: `packages/server-hono/src/views.ts` if new views are needed.
- Modify: `packages/rpc/src/index.ts`
- Tests:
  - Create `packages/application/test/integration.test.ts`
  - Modify `packages/rpc/test/requester.test.ts`

**How:**

- [x] Add `IntegrationService` methods:

```ts
resolvePlayerByIdentity(input)
resolveOrRegisterPlayerByIdentity(input)
startSessionByIdentity(input)
previewCheckoutByIdentity(input)
confirmCheckoutByIdentity(input)
getWalletByIdentity(input)
getAssetsByIdentity(input)
getHistoryByIdentity(input)
redeemByIdentity(input)
```

- [x] `autoRegister: true` may create a player and bind the identity. This replaces the bot's current need for a staff token.
- [x] All player actions must reuse existing `playerCommands`, `playerCheckoutCommands`, `playerRedeemCommands`, and query services.
- [x] Do not duplicate settlement logic in the integration service.
- [x] Add Hono endpoints under `/rpc/integration/players/by-identity/*`.
- [x] Accept either:

```json
{"identity":{"provider":"qq","subject":"123456"}}
```

or:

```json
{"identityKey":"QQ:123456"}
```

**Tests:**

- [x] Resolves existing identity and starts session.
- [x] Auto-register creates player, binds identity, and starts session.
- [x] Missing identity returns 404 when `autoRegister` is false.
- [x] Integration principal can call these endpoints.
- [x] Player, machine, and unauthenticated principals cannot call these endpoints.
- [x] RPC manifest includes every new endpoint.

**Verification:**

```bash
bun test packages/application/test/integration.test.ts packages/rpc/test/requester.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/api.md`: add integration player actions.
- [x] Rename `docs/bot-agent.md` to `docs/integrations-and-machines.md` and document the integration token flow there.

**Commit:**

```bash
git add packages/application packages/runtime packages/server-hono packages/rpc docs/api.md docs/integrations-and-machines.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "feat: add integration player actions"
```

**Completion note:** Implemented application-level integration identity actions, Hono `/rpc/integration/players/by-identity/*` routes, runtime wiring, RPC manifest entries, and Integration/Machine docs. Verification passed: `bun test packages/application/test/integration.test.ts packages/server-hono/test/app.test.ts packages/rpc/test/requester.test.ts packages/runtime/test/deployment.test.ts` (83 pass), `bun run typecheck`, `git diff --check`, and full `bun test` (301 pass).

---

### Task 5: Update Bot Client and AstrBot to Use One Integration Token

**Why:** The API improvement is not complete until the actual bot no longer needs `bot_token + player_token + staff_token` for normal commands.

**Files in PRiSM Next:**

- Modify: `packages/bot-client/src/index.ts`
- Modify: `packages/bot-client/test/index.test.ts`
- Modify: `docs/integrations-and-machines.md`

**Files in AstrBot repo:**

- Modify: `packages/plugin-prism-next-astrbot/prism_astrbot/config.py`
- Modify: `packages/plugin-prism-next-astrbot/prism_astrbot/client.py`
- Modify: `packages/plugin-prism-next-astrbot/prism_astrbot/handlers.py`
- Modify: `packages/plugin-prism-next-astrbot/main.py` if command wiring changes.
- Modify: `packages/plugin-prism-next-astrbot/_conf_schema.json`
- Modify tests under `packages/plugin-prism-next-astrbot/tests/`
- Modify plugin README.

**How:**

- [x] Add new `createPrismBotClient` option:

```ts
integrationToken: string
```

- [x] Remove `botToken/playerToken/staffToken` constructor fields from the normal client API. Tests should fail if a command path still requires more than `integrationToken`.
- [x] New client methods call `/rpc/integration/players/by-identity/*`.
- [x] AstrBot config should prefer:

```text
base_url
integration_token
provider
auto_register
mahjong_tables
mahjong_table_size
mahjong_label_prefix
```

- [x] Remove `bot_token`, `player_token`, and `staff_token` from the AstrBot normal config schema. If a developer still has these values in a local config, the plugin should fail validation with a clear message telling them to create one integration token.
- [x] Mahjong join/start/leave should use integration endpoints for player session start and stopping bot-created overlay sessions once Task 6 adds the stop action.

**Tests:**

- [x] Bot client test asserts start session by QQ makes exactly one integration API request after migration.
- [x] AstrBot handler test asserts `/入场` and `/上桌` no longer require player token.
- [x] AstrBot config validation accepts `integration_token` alone for normal commands.

**Verification:**

```bash
bun test packages/bot-client/test/index.test.ts
bun run typecheck
cd "packages/plugin-prism-next-astrbot"
python3 tests/test_handlers.py
python tests/test_astrbot_import.py
python -m py_compile main.py prism_astrbot/__init__.py prism_astrbot/config.py prism_astrbot/handlers.py prism_astrbot/client.py tests/test_handlers.py tests/test_astrbot_import.py
git diff --check
```

**Docs:**

- [x] Update both `docs/integrations-and-machines.md` and external plugin README.

**Commit:**

Commit PRiSM Next changes:

```bash
git add packages/bot-client docs/integrations-and-machines.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "feat: move bot client to integration token"
```

Commit AstrBot changes:

```bash
cd "packages/plugin-prism-next-astrbot"
git add prism_astrbot main.py _conf_schema.json README.md tests docs
git commit -m "feat: use prism integration token"
```

**Completion note:** Migrated `@prism/bot-client` and Koishi normal commands to `integrationToken` and `/rpc/integration/players/by-identity/*`; updated the external AstrBot plugin to use `integration_token`, reject legacy token fields, and start Mahjong overlay sessions through integration identity actions. Verification passed: `bun test packages/bot-client/test/client.test.ts packages/koishi-plugin/test/plugin.test.ts packages/runtime/test/deployment.test.ts` (12 pass), `bun run typecheck`, full `bun test` (302 pass), AstrBot `python3 tests/test_handlers.py`, AstrBot import test with uv tool Python, AstrBot `py_compile`, and `git diff --check` in both repositories.

---

### Task 6: Add Integration Stop-Own Session and Mahjong Overlay Support

**Why:** Mahjong overlay sessions are normal parallel sessions, but bot should be able to stop the Mahjong session it created without a full staff token.

**Files:**

- Modify: `packages/application/src/integration.ts`
- Modify: `packages/server-hono/src/index.ts`
- Modify: `packages/rpc/src/index.ts`
- Modify: `packages/bot-client/src/index.ts`
- Modify external AstrBot files from Task 5.
- Tests:
  - `packages/application/test/integration.test.ts`
  - `packages/bot-client/test/client.test.ts`
  - AstrBot tests.

**How:**

- [x] When integration starts a session, record enough audit metadata to know it was started by an integration token.
- [x] Add endpoint:

```http
POST /rpc/integration/players/by-identity/sessions/:sessionId/stop
```

- [x] Allow stop only if:
  - identity resolves to the same player;
  - session belongs to that player;
  - session is active;
  - session label or metadata identifies it as integration-created, or token scope permits `integration.session.stop`.
- [x] Stop closes the session and leaves it unpaid, same semantics as staff stop.
- [x] Do not settle or deduct wallet here.

**Tests:**

- [x] Integration can stop its own Mahjong overlay session.
- [x] Integration cannot stop another player's session.
- [x] Stop leaves `payment_status = unpaid`.
- [x] Unified checkout still includes stopped unpaid overlay session.

**Verification:**

```bash
bun test packages/application/test/integration.test.ts packages/core/test/time-pricing.test.ts
bun run typecheck
cd "packages/plugin-prism-next-astrbot" && python3 tests/test_handlers.py
git diff --check
```

**Docs:**

- [x] Document Mahjong overlay flow in `docs/integrations-and-machines.md`.
- [x] Document that table seating can remain bot-local for now, but billing sessions are stored in PRiSM.

**Commit:** Use focused commits in both repos.

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Focused backend/client tests: `bun test packages/application/test/integration.test.ts packages/core/test/time-pricing.test.ts packages/server-hono/test/app.test.ts packages/rpc/test/requester.test.ts packages/bot-client/test/client.test.ts packages/runtime/test/deployment.test.ts packages/adapter-sqlite/test/repositories.test.ts packages/adapter-d1/test/repositories.test.ts`: 140 pass, 0 fail.
- `bun run typecheck`: passed.
- Full backend suite: `bun test`: 306 pass, 0 fail.
- `git diff --check`: passed.
- AstrBot plugin: `python3 tests/test_handlers.py`: passed.
- AstrBot import check: `python tests/test_astrbot_import.py`: passed.
- AstrBot syntax check: `python -m py_compile main.py prism_astrbot/__init__.py prism_astrbot/config.py prism_astrbot/handlers.py prism_astrbot/client.py tests/test_handlers.py tests/test_astrbot_import.py`: passed.
- AstrBot `git diff --check`: passed.

---

### Task 7: Create Device Action Domain and HA/Game Machine Split

**Why:** HA power/AC and game-machine coin/Aime are both "device operations" to staff, but they are different execution systems. The API should not force bot or Web clients to understand HA versus WebSocket details.

**Files:**

- Modify/Create: `packages/core/src/device-command.ts`
- Create: `packages/core/src/device-action.ts` if splitting from current command file is cleaner.
- Modify: `packages/core/src/index.ts`
- Create: `packages/application/src/device-actions.ts`
- Modify: `packages/application/src/player-commands.ts`
- Modify: `packages/runtime/src/index.ts`
- Tests:
  - `packages/core/test/device-command.test.ts`
  - `packages/application/test/device-actions.test.ts`

**How:**

- [x] Introduce target categories:

```ts
type DeviceTargetKind = "facility" | "game_machine";
type DeviceExecutorKind = "home_assistant" | "machine_ws";
```

- [x] Introduce action types:

```ts
type DeviceActionType =
  | "power.on"
  | "power.off"
  | "ac.set_temperature"
  | "coin"
  | "aime.scan"
  | "door.open";
```

- [x] Replace generated action names with explicit action names. Do not keep `"power" | "scan"` aliases in the public API.
- [x] Centralize rules:
  - Player-triggered `coin` and `aime.scan` require active session.
  - `coin` respects cooldown.
  - Staff-triggered override may bypass active session only if explicitly marked.
  - Facility actions may have their own policy, configured per device.

**Tests:**

- [x] Player without active session cannot trigger `coin`.
- [x] Player with active session can trigger `coin`.
- [x] Cooldown blocks repeated `coin`.
- [x] HA facility action routes to HA executor.
- [x] Game-machine action routes to machine executor.

**Verification:**

```bash
bun test packages/core/test/device-command.test.ts packages/application/test/device-actions.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/architecture.md`: document facility device vs game machine.
- [x] `docs/api.md`: document device action request/response.

**Commit:**

```bash
git add packages/core packages/application packages/runtime docs/api.md docs/architecture.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "feat: split device action execution model"
```

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Plan verification: `bun test packages/core/test/device-command.test.ts packages/application/test/device-actions.test.ts`: 10 pass, 0 fail.
- `bun run typecheck`: passed.
- Full backend suite: `bun test`: 309 pass, 0 fail.
- `git diff --check`: passed.

---

### Task 8: Add Integration Device Action API

**Why:** Bot needs to request machine/facility actions by QQ identity, with backend eligibility checks.

**Files:**

- Modify: `packages/application/src/integration.ts`
- Modify: `packages/server-hono/src/index.ts`
- Modify: `packages/server-hono/src/types.ts`
- Modify: `packages/rpc/src/index.ts`
- Modify: `packages/bot-client/src/index.ts`
- Tests:
  - `packages/application/test/integration.test.ts`
  - `packages/rpc/test/requester.test.ts`
  - `packages/bot-client/test/index.test.ts`

**How:**

- [x] Add endpoint:

```http
POST /rpc/integration/players/by-identity/device-actions
```

- [x] Request body:

```json
{
  "identity": {
    "provider": "qq",
    "subject": "123456"
  },
  "target": {
    "kind": "game_machine",
    "id": "maimai-dx-1"
  },
  "action": {
    "type": "coin",
    "payload": {
      "count": 1
    }
  }
}
```

- [x] Backend resolves identity, checks player status/session, applies action rules, records command/action, then dispatches to the proper executor.
- [x] Return staff-readable result:

```json
{
  "action": {
    "id": "command-1",
    "status": "pending",
    "target": {"kind":"game_machine","id":"maimai-dx-1"},
    "type": "coin"
  }
}
```

**Tests:**

- [x] QQ user with active session can request coin.
- [x] QQ user without active session receives `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`.
- [x] Unknown identity receives 404 unless auto-register is explicitly allowed.
- [x] Bot client sends one integration-token request.

**Verification:**

```bash
bun test packages/application/test/integration.test.ts packages/rpc/test/requester.test.ts packages/bot-client/test/client.test.ts packages/server-hono/test/app.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] Update `docs/integrations-and-machines.md` with bot machine command examples.
- [x] Update `docs/api.md` integration device action section.

**Commit:** Focused commit in PRiSM Next.

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Plan verification: `bun test packages/application/test/integration.test.ts packages/rpc/test/requester.test.ts packages/bot-client/test/client.test.ts packages/server-hono/test/app.test.ts`: 94 pass, 0 fail.
- `bun run typecheck`: passed.
- Full backend suite: `bun test`: 314 pass, 0 fail.
- `git diff --check`: passed.

---

### Task 9: Add Machine WebSocket Channel

**Why:** Coin and Aime should not use polling long term. Machine software should keep a WebSocket to receive real-time commands and report execution results.

**Files:**

- Create: `packages/application/src/machine-connections.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/serve.ts`
- Modify: `packages/server-hono/src/types.ts`
- Modify/Create: `packages/server-hono/src/machine-ws.ts`
- Modify: `packages/storage-sql/src/index.ts`
- Modify: `packages/storage-sql/src/repositories.ts`
- Add migration under `migrations/`
- Tests:
  - `packages/application/test/machine-connections.test.ts`
  - runtime/server WebSocket test if feasible.

**How:**

- [x] Machine connects with machine token and machine id.
- [x] First message:

```json
{
  "type": "hello",
  "machineId": "maimai-dx-1",
  "capabilities": ["coin", "aime.scan"]
}
```

- [x] Server records online status, last heartbeat, and capabilities.
- [x] Server sends command:

```json
{
  "type": "command",
  "commandId": "command-1",
  "action": "coin",
  "payload": {"count": 1},
  "expiresAt": "2026-07-07T13:30:00.000Z"
}
```

- [x] Machine replies:

```json
{
  "type": "ack",
  "commandId": "command-1",
  "status": "success"
}
```

or:

```json
{
  "type": "ack",
  "commandId": "command-1",
  "status": "failed",
  "message": "coin controller timeout"
}
```

- [x] Failed/timeout commands must be visible to staff.
- [x] Delete generated polling endpoints once WebSocket delivery has tests.

**Tests:**

- [x] Machine auth rejects integration/player/staff token.
- [x] Machine hello updates status/capabilities.
- [x] Pending command is delivered through WebSocket.
- [x] Ack marks command successful.
- [x] Failed ack stores failure message.
- [x] Disconnect marks machine offline or stale after heartbeat timeout.

**Verification:**

```bash
bun test packages/application/test/machine-connections.test.ts packages/server-hono/test/machine-ws.test.ts packages/adapter-sqlite/test/repositories.test.ts packages/adapter-d1/test/repositories.test.ts packages/storage-sql/test/schema.test.ts
bun run typecheck
git diff --check
```

If a runnable WebSocket smoke test is added:

```bash
bun test packages/runtime/test/machine-websocket.test.ts
```

**Docs:**

- [x] `docs/api.md`: WebSocket protocol.
- [x] `docs/deployment.md`: machine software connection requirements.
- [x] `docs/architecture.md`: machine channel lifecycle.

**Commit:** Focused commit.

**Completion note:** Machine WebSocket channel implemented on `codex/integration-machine-api-redesign`; the later compatibility-removal pass deleted the legacy `/rpc/agent/*` routes, polling services, RPC manifest entries, and `@prism/agent-client` package.

Verification summary:

- Plan verification: `bun test packages/application/test/machine-connections.test.ts packages/server-hono/test/machine-ws.test.ts packages/adapter-sqlite/test/repositories.test.ts packages/adapter-d1/test/repositories.test.ts packages/storage-sql/test/schema.test.ts`: 38 pass, 0 fail.
- `bun run typecheck`: passed.
- Full backend suite: `bun test`: 323 pass, 0 fail.
- `git diff --check`: passed.

---

### Task 10: Add Home Assistant Direct Executor

**Why:** HA power/AC is not the same system as game-machine WebSocket. It should be a separate executor behind the same device action service.

**Files:**

- Create: `packages/runtime/src/home-assistant-executor.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: config/docs for HA base URL/token.
- Tests:
  - Create `packages/runtime/test/home-assistant-executor.test.ts` if runtime tests exist, or application-level executor mock tests.

**How:**

- [x] Add executor interface:

```ts
type DeviceActionExecutor = {
  execute(input: DeviceActionExecutionInput): Promise<DeviceActionExecutionResult>;
};
```

- [x] HA executor maps:
  - `power.on` -> HA service call.
  - `power.off` -> HA service call.
  - `ac.set_temperature` -> HA climate service call.
- [x] No Aime or coin action should route to HA.
- [x] If HA returns non-2xx, mark action failed with backend-visible message.

**Tests:**

- [x] `power.on` sends correct HA service request.
- [x] `ac.set_temperature` sends correct HA payload.
- [x] `coin` rejected if configured with HA executor.
- [x] HA failure becomes failed command/action.

**Verification:**

```bash
bun test packages/runtime/test/home-assistant-executor.test.ts packages/application/test/device-actions.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/deployment.md`: HA environment variables and cloud HA assumptions.
- [x] `docs/api.md`: facility action examples.

**Commit:** Focused commit.

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Plan verification: `bun test packages/runtime/test/home-assistant-executor.test.ts packages/application/test/device-actions.test.ts`: 7 pass, 0 fail.
- `bun run typecheck`: passed.
- Full backend suite: `bun test`: 328 pass, 0 fail.
- `git diff --check`: passed.

---

### Task 11: Redesign Dashboard Device Page Around Facility Devices and Game Machines

**Why:** Staff should see the real store model: facilities controlled through HA and game machines connected through machine software/WebSocket.

**Files:**

- Modify: `packages/prism-dashboard/lib/src/features/devices/devices_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/api/api_client.dart`
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Modify: `packages/prism-dashboard/test/devices_screen_test.dart`
- Update: `packages/prism-dashboard/README.md`

**How:**

- [x] Split UI into two tabs or sections:
  - `设施设备`: power, AC, light, door, HA/direct status.
  - `游戏机器`: machine WebSocket online state, capabilities, last heartbeat, coin/Aime command status.
- [x] Use "机器软件" or "机器接入" for machine-facing copy.
- [x] Recent command list must show:
  - device/machine name;
  - action type;
  - player if known;
  - requested date and time;
  - delivery/execution status;
  - failure message if present.
- [x] Do not collapse different dates into ambiguous `7/4 20:15`; use the project-wide time format already requested elsewhere.

**Tests:**

- [x] Widget test renders both sections.
- [x] Widget test shows WebSocket machine status/capabilities.
- [x] Widget test shows HA facility status.
- [x] Widget test verifies no generated device-role wording remains in normal copy.

**Verification:**

```bash
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test -- --name "device"
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
git diff --check
```

**Browser check:**

- [x] Start backend and dashboard.
- [x] Open device page.
- [x] Click device page navigation and refresh action; both facility and game-machine sections are visible in the same workspace.
- [x] Screenshot verified at `/tmp/prism-dashboard-task11-device-page-with-data.png`.

**Docs:**

- [x] Update `packages/prism-dashboard/README.md`.
- [x] Update `docs/api.md` for `/rpc/staff/machine-connections`; `docs/architecture.md` already contained the facility/game-machine terminology and did not need a separate wording change.

**Commit:** Focused commit.

**Completion note:** Completed on `codex/integration-machine-api-redesign`.

Verification summary:

- Added staff machine connection read endpoint `/rpc/staff/machine-connections` and RPC manifest entry so the Dashboard does not infer WebSocket machine state from facility device rows.
- `bun run typecheck`: passed.
- `bun test`: 329 pass, 0 fail.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze`: passed.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test`: 87 pass, 0 fail.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build`: passed.
- `git diff --check`: passed.
- Browser verification: local backend restarted at `http://localhost:8787`, dashboard served at `http://localhost:63241`, Playwright launched local Chrome, logged in through a temporary admin session, applied existing local SQLite migration `0005_device_action_model.sql` so old `device_states` rows had `target_kind/executor_kind`, clicked `设备看板`, clicked refresh, captured `/tmp/prism-dashboard-task11-device-page-with-data.png`, then removed temporary preview rows and temporary admin session.

---

### Task 12: Add Real Player Web Session Architecture

**Why:** Future player Web login, self-entry, and self-checkout cannot safely use the current global `player_token + X-PRiSM-Player-Id` model.

**Files:**

- Modify: `packages/storage-sql/src/index.ts`
- Modify: `packages/storage-sql/src/repositories.ts`
- Add migration under `migrations/`
- Create: `packages/application/src/player-auth.ts`
- Modify: `packages/server-hono/src/auth.ts`
- Modify: `packages/server-hono/src/index.ts`
- Modify: `packages/server-hono/src/types.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/rpc/src/index.ts`
- Tests:
  - `packages/application/test/player-auth.test.ts`
  - `packages/rpc/test/requester.test.ts`

**How:**

- [x] Add `player_sessions` table:
  - `id`
  - `player_id`
  - `token_hash`
  - `expires_at`
  - `created_at`
  - `last_used_at`
  - `revoked_at`
- [x] Add `POST /rpc/player-auth/login/by-identity` for trusted first version. Later OAuth/OTP can be added without changing player APIs.
- [x] Add player session authentication path in `authenticate`.
- [x] New `/rpc/player/*` routes use authenticated player session principal only.
- [x] Remove public use of `/rpc/player/* + X-PRiSM-Player-Id`. Runtime and server tests now log in through player auth or use explicit player-session mocks.

**Tests:**

- [x] Login by existing identity creates player session.
- [x] Player session can call `/rpc/player/me`.
- [x] Player session cannot act as another player.
- [x] Global player API token requests fail for browser-facing routes.

**Verification:**

```bash
bun test packages/application/test/player-auth.test.ts packages/rpc/test/requester.test.ts
bun run typecheck
git diff --check
```

**Docs:**

- [x] `docs/api.md`: player auth section.
- [x] `docs/architecture.md`: public player session security model.
- [x] `docs/deployment.md`: player Web deployment notes.

**Commit:** Focused commit.

**Completion note:** Implemented `player_sessions`, player auth service, `/rpc/player-auth/login/by-identity`, player-session-only `/rpc/player/*` authentication, RPC manifest entries, runtime composition, migration, tests, and docs. No visible UI changed, so screenshot/click verification was not required for this task. Verification: `bun run typecheck` passed; `bun test` passed with 333 tests.

---

### Task 13: Cleanup and Removal Pass

**Why:** The project has not entered production, so the final codebase should not keep generated API roles, generated polling routes, or documentation that teaches the wrong mental model.

**Files:**

- Modify: `docs/api.md`
- Rename/update: `docs/bot-agent.md` -> `docs/integrations-and-machines.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/roadmap.md`
- Modify: `packages/prism-dashboard/README.md`
- Modify external plugin README.

**How:**

- [x] Remove generated public route documentation:
  - `/rpc/bot/identities/resolve`
  - `/rpc/player/* + X-PRiSM-Player-Id`
  - `/rpc/agent/*`
- [x] Add final replacement map:

```text
old three-token bot flow -> integration token flow
generated polling machine route -> machine WebSocket
global player token -> player session
```

- [x] Add implementation order:
  1. dashboard exposes integration token;
  2. integration player actions;
  3. bot-client migration;
  4. AstrBot migration;
  5. integration device actions;
  6. machine WebSocket;
  7. player Web sessions;
  8. generated endpoint removal and documentation cleanup.

**Tests:**

- [x] No automated tests required for docs-only task, but run `git diff --check`.

**Verification:**

```bash
git diff --check
```

**Commit:**

```bash
git add docs packages/prism-dashboard/README.md docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "docs: define integration and machine api cleanup"
```

**Completion note:** Public docs now describe Integration Token, Machine WebSocket, and player session flows. Root README, API reference, integration/machine guide, roadmap, migration notes, extension guide, and external AstrBot README no longer teach the old generated public bot/player/agent route model. Verification: `git diff --check` passed.

---

### Task 14: Full End-to-End Verification

**Why:** This redesign cuts across auth, bot, device actions, machine delivery, dashboard, and docs. Passing isolated tests is not enough.

**Files:**

- `packages/runtime/src/local-server.ts`
- `packages/runtime/src/serve.ts`
- `packages/runtime/test/local-server.test.ts`
- `docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md`

**How:**

- [x] Start backend with a real local SQLite DB.
- [x] Generate or seed:
  - integration token;
  - machine token;
  - staff session;
  - player with QQ identity;
  - one HA facility device;
  - one game machine with WebSocket capability.
- [x] Run bot-client smoke:
  - QQ identity starts session through integration API;
  - QQ identity requests wallet;
  - QQ identity requests coin;
  - QQ identity previews checkout;
  - QQ identity confirms checkout.
- [x] Run machine WebSocket smoke:
  - machine connects;
  - coin command delivered;
  - machine ACKs success;
  - dashboard command status updates.
- [x] Run HA executor smoke with mocked HA endpoint if real HA secrets are not available.
- [x] Run dashboard browser smoke:
  - create integration token;
  - open device page;
  - inspect facility/game machine sections;
  - capture screenshots;
  - click key controls.
- [x] Run AstrBot handler smoke using local PRiSM backend.

**Commands:**

```bash
bun test
bun run typecheck
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test
PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build
git diff --check
```

External AstrBot:

```bash
cd "packages/plugin-prism-next-astrbot"
python3 tests/test_handlers.py
python tests/test_astrbot_import.py
python -m py_compile main.py prism_astrbot/__init__.py prism_astrbot/config.py prism_astrbot/handlers.py prism_astrbot/client.py tests/test_handlers.py tests/test_astrbot_import.py
git diff --check
```

**Docs:**

- [x] Confirm all changed API behavior is in `docs/api.md`.
- [x] Confirm architecture is in `docs/architecture.md`.
- [x] Confirm bot setup is in `docs/integrations-and-machines.md` and plugin README.
- [x] Confirm dashboard staff-facing copy matches UI.

**Commit:**

```bash
git add docs/superpowers/plans/2026-07-07-integration-machine-api-redesign.md
git commit -m "test: verify integration and machine api redesign"
```

**Completion note:** Completed on 2026-07-08. Full verification used `/tmp/prism-task14-e2e.sqlite` and a mocked Home Assistant server on `127.0.0.1:18765`. The smoke test installed the store, logged in owner staff, created an extra integration token, created a time-priority pricing rule, started a QQ-identity session through the integration API, granted balance, requested wallet, delivered a coin command to `maimai-dx-1` over `/rpc/machine/ws`, ACKed it, executed `power.on` against the HA mock, logged in through `/rpc/player-auth/login/by-identity`, previewed checkout, confirmed checkout, and checked staff device-command and machine-connection views. During this smoke run, Bun WebSocket upgrade failed because `server.upgrade` had been extracted and called without its `this` binding; fixed by moving local fetch handling to `packages/runtime/src/local-server.ts` and adding `packages/runtime/test/local-server.test.ts`.

Verification evidence:

- `bun test`: 334 pass, 0 fail.
- `bun run typecheck`: passed.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:analyze`: no issues found.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:test`: all tests passed.
- `PATH="${FLUTTER_HOME}/bin:$PATH" bun run prism-dashboard:build`: built `packages/prism-dashboard/build/web`.
- `git diff --check`: passed.
- External AstrBot: `python3 tests/test_handlers.py`, AstrBot import test, `py_compile`, and `git diff --check` passed.
- Real backend smoke log: `/tmp/prism-task14-e2e.log`.
- Browser screenshots: `/tmp/prism-task14-dashboard-after-login.png`, `/tmp/prism-task14-dashboard-token-created.png`, `/tmp/prism-task14-dashboard-devices.png`, `/tmp/prism-task14-dashboard-devices-refresh.png`.

---

## 6. Recommended First Milestone

Do not attempt the entire redesign in one model turn.

Start with this narrow milestone:

1. Task 2: Backend/storage/auth accept only integration and machine API token roles.
2. Task 1: Dashboard can create integration and machine tokens.
3. Task 3: Shared identity parser.
4. Task 4: Integration player actions by identity.
5. Task 5: Bot client and AstrBot use one integration token for normal player commands.

This milestone fixes the immediate API pain without waiting for WebSocket machine work.

Second milestone:

1. Task 7: Device action domain split.
2. Task 8: Integration device action API.
3. Task 9: Machine WebSocket.
4. Task 11: Dashboard device page redesign.

Third milestone:

1. Task 12: Real player Web sessions.
2. Task 13: Cleanup docs and generated endpoint removal.
3. Task 14: End-to-end verification.

---

## 7. Self-Review Checklist

- [x] The plan explains what to change.
- [x] The plan explains why the current generated API is not aligned with the actual business.
- [x] The plan explains how to replace generated roles directly because the project is not in production yet.
- [x] The plan distinguishes HA facility control from game-machine WebSocket command delivery.
- [x] The plan preserves prism-neo's convenient external identity flow through a safer integration API.
- [x] The plan includes full tests and documentation synchronization requirements.
- [x] The plan is saved locally so future workers do not rely on compressed chat context.
