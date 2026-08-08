# Koishi Mahjong Table State Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive started Mahjong tables from backend active sessions so stale Bot memory cannot block seating or leaving a table.

**Architecture:** Retain in-memory waiting seats only. A service helper rebuilds each configured table's `activeSessions` from the current Integration active-session response and is called by `/list`, `/上桌`, and `/下桌`.

**Tech Stack:** TypeScript, Koishi, Bun test runner, Integration active-session API.

## Global Constraints

- Change only `packages/koishi-plugin` production files.
- Backend active sessions are authoritative for started Mahjong tables.
- Waiting seats remain process-local and are the only state lost at Bot restart.
- `/list`, `/上桌`, and `/下桌` must synchronize from the same active-session shape.
- Bump plugin version from `0.1.13` to `0.1.14` and update README.

---

### Task 1: Synchronize Started Mahjong Tables

**Files:**
- Modify: `packages/koishi-plugin/src/index.ts`
- Modify: `packages/koishi-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: `client.listActiveSessions(): { sessions: ActiveSessionListItem[] }`.
- Produces: `syncMahjongTableStates(sessions: readonly ActiveSessionListItem[]): void`.

- [ ] **Step 1: Write failing tests**

Add a stale-state test: create an active Mahjong table, return no matching backend Mahjong session, then assert `/上桌 a` allows waiting. Add a restart-recovery test: return a matching active Mahjong session while memory is empty, call `/下桌 a`, and assert the backend session ID is stopped.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test test/plugin.test.ts --test-name-pattern "mahjong state synchronization"`

Expected: FAIL because started-table state is not rebuilt from active sessions.

- [ ] **Step 3: Implement synchronization**

Implement `syncMahjongTableStates` by matching active session labels to `mahjongSessionLabel(table, configuredPrefix)`, replacing every table's `activeSessions` map with matching backend session IDs, and removing waiting seats that transitioned to an active session. Call it after fetching sessions in `listActiveSessions`, before state checks in `mahjongJoin`, and before finding the session in `mahjongLeave`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `bun test test/plugin.test.ts --test-name-pattern "mahjong state synchronization|mahjong commands"`

Expected: PASS for stale-state cleanup, restart recovery, and existing seating behavior.

### Task 2: Publish Documentation and Package Output

**Files:**
- Modify: `packages/koishi-plugin/README.md`
- Modify: `packages/koishi-plugin/package.json`
- Modify: `packages/koishi-plugin/lib/index.js`
- Modify: `packages/koishi-plugin/lib/index.d.ts`

- [ ] **Step 1: Update documentation and version**

Document that started Mahjong tables are recovered from backend sessions after restart while unfinished waiting seats remain process-local. Set package version to `0.1.14`.

- [ ] **Step 2: Build and verify**

Run: `bun run typecheck && bun run test && bun run build && git diff --check`

Expected: all commands exit 0 and generated library output matches source.

- [ ] **Step 3: Commit**

Run: `git -C packages/koishi-plugin add src/index.ts test/plugin.test.ts README.md package.json lib/index.js lib/index.d.ts && git -C packages/koishi-plugin commit -m "sync mahjong table state from active sessions"`

## Plan Self-Review

- Coverage includes stale-memory cleanup, restart recovery, leave semantics, docs, version, and full plugin verification.
- No Worker or database changes are needed.
