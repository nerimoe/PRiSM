# Server Package Merge & Architectural Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `packages/server-hono`, `packages/runtime`, and `packages/platform` into a unified `@prism/server` package, eliminate virtual HTTP request dispatching, centralize legacy single-store APIs with deprecation notices, disambiguate cross-package duplicated filenames, and unify Cloudflare Worker and Bun runtime entrypoints.

**Architecture:** A single unified backend package `packages/server` hosting direct Hono sub-routers (`/api/v1/auth`, `/api/v1/shops/:shopCode/*`, and `/api/v1/legacy/*`), with dependency injection via Hono middleware (`tenantMiddleware` injecting `@prism/application` dependencies), eliminating `new Request()` forwarding. Cloudflare Worker (`worker.ts` with D1, DO, Assets, Crons) and Bun local server (`serve.ts` with SQLite and WebSocket) share the same compiled Hono application.

**Tech Stack:** Bun, TypeScript 5.9, Hono 4.10, Cloudflare Workers / Miniflare / D1 / Durable Objects, SQLite, `@simplewebauthn/server`, Zod.

## Global Constraints

- Domain logic stays in `@prism/core`; application orchestration stays in `@prism/application`; storage stays in `@prism/storage-sql` and adapters.
- Backwards compatibility: Existing legacy API endpoints (`/api/v1/player/*`, `/api/v1/staff/*`, `/api/v1/integration/*`) must remain functional and mapped to default shop scope, emitting deprecation headers.
- Every code change must update corresponding documentation per `AGENTS.md`.
- Strict TypeScript: `bun run typecheck` must pass with zero errors after every task.
- Zero regression: All existing Bun tests must pass.

---

### Task 1: Disambiguate Application Layer Filenames (`settlement-service.ts`, `redeem-service.ts`)

**Files:**
- Rename/Move:
  - `packages/application/src/settlement.ts` -> `packages/application/src/settlement-service.ts`
  - `packages/application/src/redeem.ts` -> `packages/application/src/redeem-service.ts`
- Modify:
  - `packages/application/src/index.ts`
  - `packages/application/src/live-billing-snapshot.ts`
  - `packages/application/src/staff-operations.ts`
  - `packages/application/src/player-commands.ts`
- Test:
  - `packages/application/test/settlement.test.ts`
  - `packages/application/test/redeem.test.ts`

**Interfaces:**
- Consumes: `@prism/core` pure functions (`settleSession`, `previewSessionSettlement`, `redeemGift`).
- Produces: `createSettlementService`, `createRedeemService` re-exported from `@prism/application`.

- [ ] **Step 1: Check existing tests pass before modification**

Run: `bun test packages/application`
Expected: PASS

- [ ] **Step 2: Rename files using git mv to preserve history**

```bash
git mv packages/application/src/settlement.ts packages/application/src/settlement-service.ts
git mv packages/application/src/redeem.ts packages/application/src/redeem-service.ts
```

- [ ] **Step 3: Update imports within `packages/application`**

In `packages/application/src/index.ts`:
```ts
export * from "./settlement-service";
export * from "./redeem-service";
```
In `packages/application/src/live-billing-snapshot.ts`:
```ts
import { createSettlementService } from "./settlement-service";
```
In `packages/application/src/staff-operations.ts` and `player-commands.ts`:
Update any relative imports from `./settlement` or `./redeem` to `./settlement-service` or `./redeem-service`.

- [ ] **Step 4: Verify tests and typecheck**

Run: `bun test packages/application && bun run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/application
git commit -m "refactor(application): disambiguate settlement and redeem service filenames"
```

---

### Task 2: Scaffold `@prism/server` Package & Workspace Configuration

**Files:**
- Create:
  - `packages/server/package.json`
  - `packages/server/tsconfig.json`
  - `packages/server/src/index.ts`
  - `packages/server/test/smoke.test.ts`
- Modify:
  - `package.json` (root workspaces & scripts)
  - `tsconfig.json` (root project references)

**Interfaces:**
- Consumes: `@prism/core`, `@prism/application`, `@prism/storage-sql`, `@prism/adapter-d1`, `@prism/adapter-sqlite`.
- Produces: `@prism/server` package registered in monorepo workspace.

- [ ] **Step 1: Create `packages/server/package.json`**

```json
{
  "name": "@prism/server",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -b"
  },
  "dependencies": {
    "@prism/adapter-d1": "workspace:*",
    "@prism/adapter-sqlite": "workspace:*",
    "@prism/application": "workspace:*",
    "@prism/core": "workspace:*",
    "@prism/storage-sql": "workspace:*",
    "@simplewebauthn/server": "^14.0.0",
    "hono": "^4.10.7",
    "zod": "^3.25.56"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250224.0",
    "bun-types": "1.3.14",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create `packages/server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["bun-types", "@cloudflare/workers-types"]
  },
  "include": ["src/**/*", "test/**/*"],
  "references": [
    { "path": "../core" },
    { "path": "../application" },
    { "path": "../storage-sql" },
    { "path": "../adapter-d1" },
    { "path": "../adapter-sqlite" }
  ]
}
```

- [ ] **Step 3: Update root `package.json` and root `tsconfig.json`**

Add `"packages/server"` to `workspaces` in root `package.json`.
Add `{ "path": "packages/server" }` to `references` in root `tsconfig.json`.

- [ ] **Step 4: Create smoke test and verify**

Create `packages/server/test/smoke.test.ts`:
```ts
import { describe, expect, it } from "bun:test";

describe("@prism/server smoke", () => {
  it("initializes workspace package", () => {
    expect(true).toBe(true);
  });
});
```
Run: `bun install && bun test packages/server && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json packages/server
git commit -m "chore: scaffold @prism/server package in workspaces"
```

---

### Task 3: Consolidate Hardware Drivers (`packages/server/src/hardware/`)

**Files:**
- Create:
  - `packages/server/src/hardware/hinata.ts`
  - `packages/server/src/hardware/ttlock.ts`
  - `packages/server/src/hardware/home-assistant.ts`
  - `packages/server/src/hardware/machine-ws.ts`
  - `packages/server/src/hardware/index.ts`
  - `packages/server/test/hardware.test.ts`
- Consolidates:
  - `packages/runtime/src/hinata-io-executor.ts` + `packages/platform/src/hinata.ts`
  - `packages/runtime/src/ttlock-executor.ts` + `packages/platform/src/devices.ts` (TTLock logic)
  - `packages/runtime/src/home-assistant-executor.ts` + `packages/server-hono/src/machine-ws.ts`

**Interfaces:**
- Consumes: Device types from `@prism/core`, crypto/PBKDF2/AES-GCM Web APIs.
- Produces:
  - `sendHinataCard`, `sendHinataCoin`, `createHinataExecutor`
  - `createTtlockExecutor`, `unlockTtlockDoor`
  - `createHomeAssistantExecutor`, `executeHomeAssistantAction`
  - `machineWebSocketHandler`

- [ ] **Step 1: Write test for consolidated Hinata E2EE and device action execution**

Write `packages/server/test/hardware.test.ts` testing card and coin payload construction, PBKDF2 salt and AES-GCM encryption.

- [ ] **Step 2: Implement consolidated hardware modules**

Port and unify `hinata.ts` (unifying PBKDF2/AES-GCM encryption with fallback and retry semantics), `ttlock.ts`, `home-assistant.ts`, and `machine-ws.ts` into `packages/server/src/hardware/`.

- [ ] **Step 3: Run hardware tests**

Run: `bun test packages/server/test/hardware.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/hardware packages/server/test/hardware.test.ts
git commit -m "feat(server): consolidate hardware drivers and executors into hardware module"
```

---

### Task 4: Port Core Middleware & App Bindings (`packages/server/src/middleware/`)

**Files:**
- Create:
  - `packages/server/src/bindings.ts`
  - `packages/server/src/middleware/auth.ts`
  - `packages/server/src/middleware/tenant.ts`
  - `packages/server/src/middleware/cors.ts`
  - `packages/server/src/middleware/rate-limit.ts`
  - `packages/server/src/middleware/geo.ts`
  - `packages/server/src/middleware/response-time.ts`
  - `packages/server/src/middleware/index.ts`
  - `packages/server/test/middleware.test.ts`

**Interfaces:**
- Consumes: Hono context, `@prism/storage-sql`, `@prism/adapter-d1`, `@prism/core` (`formatOffsetTimestamp`).
- Produces: Hono middleware functions injecting `user`, `shop`, `deps`, handling safe CORS, and projecting local timestamps.

- [ ] **Step 1: Write tests for `tenantMiddleware` and `responseTimeProjection`**

Test that `:shopCode` parameter resolves shop and injects dependencies into `c.var.deps`, and test response time projection.

- [ ] **Step 2: Implement `bindings.ts` and middleware**

Implement:
- `bindings.ts`: Definition of `AppBindings` with `Env` (DB, LIVE_BILLING, ASSETS, secrets) and `Variables` (user, shop, deps).
- `tenant.ts`: Resolve shop by public ID or UUID, create/cache application dependencies, set `c.set("shop", shop)` and `c.set("deps", deps)`.
- `cors.ts`: Strict CORS origin validation without credentials reflection.
- `response-time.ts`: Intercept JSON responses on `/api/v1/*` and project UTC instants into shop local time strings.

- [ ] **Step 3: Run middleware tests**

Run: `bun test packages/server/test/middleware.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/bindings.ts packages/server/src/middleware packages/server/test/middleware.test.ts
git commit -m "feat(server): implement core middleware and tenant dependency injection"
```

---

### Task 5: Implement Platform & System Routes

**Files:**
- Create:
  - `packages/server/src/routes/platform/auth.ts`
  - `packages/server/src/routes/platform/passkeys.ts`
  - `packages/server/src/routes/platform/user.ts`
  - `packages/server/src/routes/platform/shops.ts`
  - `packages/server/src/routes/system/health.ts`
  - `packages/server/src/routes/system/version.ts`
  - `packages/server/src/routes/web-assets.ts`
  - `packages/server/test/platform-routes.test.ts`

**Interfaces:**
- Consumes: `AppBindings`, `@simplewebauthn/server`, D1 database.
- Produces: Hono sub-routers mounted at `/api/v1/auth`, `/api/v1/shops`, `/health`, `/version`.

- [ ] **Step 1: Write tests for platform auth and shop creation**

Write tests covering registration, login, passkey challenge generation, and shop listing in `packages/server/test/platform-routes.test.ts`.

- [ ] **Step 2: Implement platform route handlers**

Port the clean route handlers from `packages/platform/src/auth.ts`, `passkeys.ts`, `shops.ts`, and add `/health`, `/version`.

- [ ] **Step 3: Run platform tests**

Run: `bun test packages/server/test/platform-routes.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes packages/server/test/platform-routes.test.ts
git commit -m "feat(server): implement platform-level and system routes"
```

---

### Task 6: Implement Multi-Tenant Shop Routes (Direct DI, No Virtual HTTP Forward)

**Files:**
- Create:
  - `packages/server/src/routes/shops/player.ts`
  - `packages/server/src/routes/shops/staff.ts`
  - `packages/server/src/routes/shops/integration.ts`
  - `packages/server/src/routes/shops/devices.ts`
  - `packages/server/src/routes/shops/pricing.ts`
  - `packages/server/src/routes/shops/assets.ts`
  - `packages/server/src/routes/shops/cashier.ts`
  - `packages/server/src/routes/shops/redeem.ts`
  - `packages/server/src/routes/shops/index.ts`
  - `packages/server/test/shop-billing-routes.test.ts`

**Interfaces:**
- Consumes: `c.get("shop")`, `c.get("deps")` (from `tenantMiddleware`).
- Produces: Direct route handlers mounted on `/api/v1/shops/:shopCode/*` executing `@prism/application` use cases directly.

- [ ] **Step 1: Write integration tests for player checkout preview and confirm**

Verify `/api/v1/shops/:shopCode/player/checkout/preview` and `/confirm` directly return domain outputs without calling synthetic `createPrismApp().fetch()`.

- [ ] **Step 2: Implement shop domain routers**

Implement direct route handlers:
- `player.ts`: session start/stop, checkout preview, checkout confirm, assets query.
- `staff.ts`: player management, asset adjustments, report queries.
- `integration.ts`: player resolution, Bot session start/stop.
- `devices.ts`: device CRUD, command dispatch (power, coin, door).
- `cashier.ts`: cashier profile, unsettled balance checkouts.

- [ ] **Step 3: Run shop billing tests**

Run: `bun test packages/server/test/shop-billing-routes.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/shops packages/server/test/shop-billing-routes.test.ts
git commit -m "feat(server): implement direct shop-scoped billing routes without virtual forward"
```

---

### Task 7: Implement Legacy API Centralization & Isolation (`packages/server/src/legacy/`)

**Files:**
- Create:
  - `packages/server/src/legacy/README.md`
  - `packages/server/src/legacy/router.ts`
  - `packages/server/src/legacy/middleware.ts`
  - `packages/server/src/legacy/tenant-resolver.ts`
  - `packages/server/src/legacy/rpc-fallback.ts`
  - `packages/server/src/legacy/handlers/player.ts`
  - `packages/server/src/legacy/handlers/staff.ts`
  - `packages/server/src/legacy/handlers/integration.ts`
  - `packages/server/src/legacy/handlers/setup.ts`
  - `packages/server/test/legacy-api.test.ts`

**Interfaces:**
- Consumes: Single-store requests without `:shopCode` (`/api/v1/player/*`, `/api/v1/staff/*`, etc.).
- Produces: `legacyRouter` exporting routes with `X-API-Deprecated: true` headers and default shop fallback mapping.

- [ ] **Step 1: Write tests for legacy API compatibility and headers**

Test that `/api/v1/player/assets` returns player assets, injects default `legacy` shop scope when missing, and includes `X-API-Deprecated: true` and `Link` headers.

- [ ] **Step 2: Implement `packages/server/src/legacy/README.md`**

Write the complete documentation:
- Architecture background: why legacy APIs exist (merger of PRiSM Next and ArcadeLink).
- Full endpoint mapping table (Legacy single-store path vs modern multi-tenant path).
- Deprecation schedule and headers.
- Migration examples for Koishi plugin and external scripts.

- [ ] **Step 3: Implement legacy router and handlers**

Wire up `legacyRouter` in `router.ts`, attach deprecation middleware, implement `tenant-resolver.ts` (local defaults to `default`, remote checks header/query/fallback), and mount handlers.

- [ ] **Step 4: Run legacy API tests**

Run: `bun test packages/server/test/legacy-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/legacy packages/server/test/legacy-api.test.ts
git commit -m "feat(server): centralize legacy single-store APIs with deprecation management and docs"
```

---

### Task 8: Assemble Top-Level App, Cloudflare Worker Entrypoint & Durable Objects

**Files:**
- Create:
  - `packages/server/src/app.ts`
  - `packages/server/src/worker.ts`
  - `packages/server/src/durable-objects/live-billing.ts`
  - `packages/server/src/tasks/cron-handlers.ts`
  - `packages/server/src/migrations/shop-time-zone-migration.ts`
  - `packages/server/test/worker-entrypoint.test.ts`

**Interfaces:**
- Consumes: Cloudflare Worker environment (`Env`, `D1Database`, `DurableObjectNamespace`, `ASSETS`).
- Produces: `export default { fetch, scheduled }` and `export { LiveBilling }`.

- [ ] **Step 1: Assemble `packages/server/src/app.ts`**

Mount all routers:
- Global middleware (CORS, Rate Limit, Error handling).
- Platform routes (`/api/v1/auth`, `/api/v1/shops`).
- Tenant shop routes (`/api/v1/shops/:shopCode`).
- Legacy routes (`legacyRouter`).
- System routes (`/health`, `/version`).
- Static web assets fallback (`/` -> `ASSETS`).

- [ ] **Step 2: Implement Worker entrypoint and Durable Object**

Port `LiveBilling` DO and cron triggers into `packages/server/src/durable-objects/live-billing.ts` and `tasks/cron-handlers.ts`.
Export default Worker in `packages/server/src/worker.ts`.

- [ ] **Step 3: Run worker entrypoint tests**

Run: `bun test packages/server/test/worker-entrypoint.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/worker.ts packages/server/src/durable-objects packages/server/src/tasks packages/server/src/migrations packages/server/test/worker-entrypoint.test.ts
git commit -m "feat(server): assemble main Hono app and Cloudflare Worker entrypoint with LiveBilling DO"
```

---

### Task 9: Implement Bun Local Server Entrypoint (`packages/server/src/serve.ts`)

**Files:**
- Create:
  - `packages/server/src/serve.ts`
  - `packages/server/src/local-server.ts`
  - `packages/server/test/local-serve.test.ts`

**Interfaces:**
- Consumes: SQLite database path (`PRISM_SQLITE_PATH` or `:memory:`), Bun HTTP/WebSocket engine.
- Produces: `Bun.serve` runner for offline single-store development and testing.

- [ ] **Step 1: Write test for local server initialization**

Test that `createLocalServer` boots with SQLite adapter, provisions default shop, and accepts requests.

- [ ] **Step 2: Implement `local-server.ts` and `serve.ts`**

Wire `Bun.serve` with WebSocket upgrade handling (`machineWebSocketHandler`) and default local shop dependency injection.

- [ ] **Step 3: Run local serve tests**

Run: `bun test packages/server/test/local-serve.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/serve.ts packages/server/src/local-server.ts packages/server/test/local-serve.test.ts
git commit -m "feat(server): implement local Bun server runtime entrypoint with SQLite and WebSocket"
```

---

### Task 10: Unify Wrangler Configuration & Root Scripts

**Files:**
- Create:
  - `wrangler.jsonc` (pointing `main` to `packages/server/src/worker.ts`)
- Modify:
  - `package.json` (update dev/check/deploy scripts)
  - `scripts/dev-all.ts`
  - `scripts/deploy-beta.ts`
  - `scripts/generate-wrangler-config.ts`
  - `packages/migration/src/cli.ts` (update imports to `@prism/server` if needed)
- Delete:
  - `wrangler.platform.jsonc`

**Interfaces:**
- Consumes: `packages/server/src/worker.ts`.
- Produces: Unified Wrangler build & deploy pipeline across the repository.

- [ ] **Step 1: Create unified `wrangler.jsonc`**

Set `"main": "packages/server/src/worker.ts"`, standard D1 binding, DO `LiveBilling`, and `assets` binding to `packages/prism-web/dist`.

- [ ] **Step 2: Update root `package.json` scripts**

Update scripts:
- `"dev:local": "bun run packages/server/src/serve.ts"`
- `"dev:worker": "bun run build:web && wrangler dev --config wrangler.jsonc"`
- `"check:server": "bun run build:web && wrangler deploy --dry-run --config wrangler.jsonc"`
- `"deploy:worker": "bun run build:web && wrangler deploy --config wrangler.jsonc"`

- [ ] **Step 3: Test dry run build**

Run: `bun run check:server`
Expected: Successful dry-run build of Worker bundle with static assets.

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc package.json scripts/ packages/migration/
git rm -f wrangler.platform.jsonc
git commit -m "chore: unify wrangler configuration and root npm scripts around @prism/server"
```

---

### Task 11: Remove Deprecated Packages (`server-hono`, `runtime`, `platform`)

**Files:**
- Delete:
  - `packages/server-hono/`
  - `packages/runtime/`
  - `packages/platform/`
- Modify:
  - `package.json` (remove deleted packages from `workspaces`)
  - `tsconfig.json` (remove deleted packages from `references`)

- [ ] **Step 1: Verify all required tests from old packages exist in `packages/server/test`**

Run: `find packages/server/test -name "*.test.ts"`
Verify test coverage matches original test suites.

- [ ] **Step 2: Remove old package directories**

```bash
git rm -r packages/server-hono packages/runtime packages/platform
```

- [ ] **Step 3: Update root `package.json` and `tsconfig.json`**

Remove `"packages/server-hono"`, `"packages/runtime"`, `"packages/platform"` from workspaces and tsconfig project references.

- [ ] **Step 4: Run `bun install && bun run typecheck`**

Run: `bun install && bun run typecheck`
Expected: PASS with 0 errors across entire workspace.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: remove deprecated server-hono, runtime, and platform packages"
```

---

### Task 12: Full Monorepo Test & Validation Run

**Files:**
- None (verification task)

- [ ] **Step 1: Run all Bun unit and integration tests**

Run: `bun test`
Expected: All tests pass across `@prism/core`, `@prism/application`, `@prism/storage-sql`, `@prism/adapter-d1`, `@prism/adapter-sqlite`, `@prism/server`.

- [ ] **Step 2: Run monorepo typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Run platform check**

Run: `bun run check:server`
Expected: Front-end builds cleanly, Worker bundle compiles and passes Wrangler dry run.

- [ ] **Step 4: Commit verification checkpoint if any fixes were needed**

---

### Task 13: Documentation Synchronization (Mandatory Rule)

**Files:**
- Modify:
  - `AGENTS.md` (update project structure and commands)
  - `README.md` (update repository overview)
  - `docs/platform-merge.md` (record completion of the deep server merge)
  - `docs/architecture.md` (update architecture and routing diagrams)
  - `docs/deployment.md` (update deployment commands)

- [ ] **Step 1: Update `AGENTS.md`**

Update `Project Structure & Module Organization`:
- Document `packages/server` as the unified backend package combining API, platform, runtime, and hardware drivers.
- Update development commands (`dev:local`, `dev:worker`, `check:server`, `deploy:worker`).

- [ ] **Step 2: Update `docs/architecture.md` and `docs/platform-merge.md`**

Reflect the elimination of virtual request forwarding, describe `tenantMiddleware`, and reference `packages/server/src/legacy/README.md`.

- [ ] **Step 3: Update `docs/deployment.md` and `README.md`**

Replace references to `packages/platform` or `packages/runtime` with `packages/server` and `wrangler.jsonc`.

- [ ] **Step 4: Verify git status and commit**

```bash
git add AGENTS.md README.md docs/
git commit -m "docs: synchronize project architecture, module structure, and deployment documentation"
```
