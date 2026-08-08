# Generic Operation Leases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize all player asset mutations across Worker instances with a generic D1 lease.

**Architecture:** Replace `checkout_locks` with `operation_locks(scope, resource_id)` and expose an `OperationLockRepository`. Application services use one shared `withOperationLease()` helper with scope `player.assets`; D1 is the source of truth and lock IDs make release safe after expiry.

**Tech Stack:** Bun, TypeScript, Cloudflare D1/SQLite, Bun test.

## Global Constraints

- Use `INSERT ... ON CONFLICT ... RETURNING` for atomic D1 acquisition.
- Lease TTL is 60 seconds and release must match `lockId`.
- Preserve unrelated dirty workspace files.

---

### Task 1: Generalize persistent lease storage

**Files:**
- Modify: `packages/core/src/storage-ports.ts`, `packages/storage-sql/src/repositories.ts`, `packages/storage-sql/src/index.ts`
- Create: `migrations/0011_operation_locks.sql`
- Test: `packages/adapter-d1/test/repositories.test.ts`

- [ ] Add `OperationLockRepository.acquire(scope, resourceId, lockId, acquiredAt, expiresAt)` and `release(scope, resourceId, lockId)`.
- [ ] Migrate existing checkout-lock rows to `operation_locks` using scope `player.assets`.
- [ ] Verify an unexpired lease cannot be acquired and a matching release removes only its own lease.

### Task 2: Share an application lease helper

**Files:**
- Create: `packages/application/src/operation-lock.ts`
- Modify: `packages/application/src/index.ts`, `packages/application/src/settlement.ts`, `packages/runtime/src/index.ts`
- Test: `packages/application/test/settlement.test.ts`

- [ ] Add `withOperationLease({ repository, scope, resourceId, id, now }, action)`.
- [ ] Replace checkout-specific lock use with `player.assets/<playerId>`.
- [ ] Verify concurrent checkout rejects one request with `OPERATION_IN_PROGRESS` and writes one settlement.

### Task 3: Cover every player asset mutation

**Files:**
- Modify: `packages/application/src/staff-assets.ts`, `packages/application/src/redeem.ts`, `packages/application/src/business-item-orders.ts`, `packages/runtime/src/index.ts`
- Test: `packages/application/test/staff-assets.test.ts`, `packages/application/test/redeem.test.ts`, `packages/application/test/business-item-orders.test.ts`

- [ ] Wrap each read-compute-replace asset path with `player.assets/<playerId>`.
- [ ] Verify a concurrent asset mutation receives `OPERATION_IN_PROGRESS` and no second asset transaction is written.

### Task 4: Verify and deploy

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-durable-checkout-lock-design.md`

- [ ] Run focused application tests, `bun run typecheck`, and `git diff --check`.
- [ ] Apply migration remotely with `bun run db:migrate:remote` and deploy with `bun run deploy:worker`.
