# Koishi Administrator Shortcut Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let configured administrators operate mentioned players with concise session and wallet shortcuts, while removing complex Bot administration commands.

**Architecture:** Extend the Koishi service with target-subject resolution and an administrator gate. Targeted reads/session actions reuse Integration identity APIs; currency adjustments and checkout override resolve the target then call existing Staff RPC endpoints. No Worker changes are required.

**Tech Stack:** TypeScript, Koishi command grammar, Bun test runner, PRiSM Integration and Staff RPC APIs.

## Global Constraints

- Change only `packages/koishi-plugin` production files.
- Administrators require `enableStaffCommands === true` and membership in `staffUserIds`.
- Non-administrators may operate only themselves; target mentions must be rejected.
- Targeted reads/session actions use the configured provider and target platform subject.
- `add` and `del` use `/rpc/staff/players/:playerId/assets/adjustments` with paid currency.
- `overwrite` immediately calls `/rpc/staff/players/:playerId/checkout/override`; it is not deferred.
- Default override reason is exactly `Koishi 管理员手动调价`.
- Remove existing complex `admin.*` commands; do not port assets/coupons/gifts/pricing management.
- Bump the published plugin version from `0.1.8` to `0.1.9`.
- Update the plugin README whenever plugin behavior changes.

---

### Task 1: Add Targeted Administrator Shortcuts

**Files:**
- Modify: `packages/koishi-plugin/src/index.ts`
- Modify: `packages/koishi-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: Integration identity methods, `staffSessionToken`, and existing Staff player adjustment/override RPC routes.
- Produces: optional-target `login`, `入场`, `logout`, `billing`, `wallet`, `items`, `history`; target-required `add`, `del`, `overwrite`.

- [ ] **Step 1: Write failing command and permission tests**

```ts
expect([...registered.keys()]).toContain("login [target:user]");
await expect(registered.get("login [target:user]")?.action(adminContext, "target-qq")).resolves.toContain("已为用户");
await expect(registered.get("login [target:user]")?.action(playerContext, "target-qq")).resolves.toBe("权限不足");
expect(client.calls).toContainEqual(["adjustStaffAssets", "player-target", [{ assetType: "currency", assetCode: "paid", amount: 10 }]]);
expect(client.calls).toContainEqual(["checkoutWithOverride", "player-target", 30, "Koishi 管理员手动调价"]);
```

- [ ] **Step 2: Run test to verify RED**

Run: `bun test test/plugin.test.ts --test-name-pattern "administrator shortcuts"`

Expected: FAIL because target commands, target authorization, and staff client methods do not exist.

- [ ] **Step 3: Write minimal implementation**

Add client methods:

```ts
async adjustStaffAssets(playerId: string, adjustments: unknown[]) {
  return this.request("POST", "/rpc/staff/players/:playerId/assets/adjustments", {
    token: this.requireStaffSessionToken(), params: { playerId }, body: { adjustments },
  });
}
async checkoutWithOverride(playerId: string, total: number, reason: string) {
  return this.request("POST", "/rpc/staff/players/:playerId/checkout/override", {
    token: this.requireStaffSessionToken(), params: { playerId }, body: { total, reason },
  });
}
```

Implement `targetSender(actor, targetSubject?)`: no target returns the actor; a target requires `staffDenied(actor)` to be null and returns the target's provider/subject sender. Use it for all optional-target commands. Resolve target `playerId` through `resolveOrRegisterIdentity` before `add`, `del`, and `overwrite`.

Register:

```ts
ctx.command("login [target:user]", "开启玩家计费场次")
ctx.command("入场 [target:user]", "入场")
ctx.command("logout [target:user]", "结算玩家计费场次")
ctx.command("billing [target:user]", "预览玩家结账费用")
ctx.command("wallet [target:user]", "查看玩家钱包")
ctx.command("items [target:user]", "查看玩家资产")
ctx.command("history [target:user]", "查看玩家历史")
ctx.command("add <target:user> <amount:number>", "增加玩家余额")
ctx.command("del <target:user> <amount:number>", "扣除玩家余额")
ctx.command("overwrite <target:user> <amount:number> [reason:text]", "覆盖结账金额并立即结账")
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `bun test test/plugin.test.ts --test-name-pattern "administrator shortcuts"`

Expected: PASS with target authorization, target identity, adjustment body, and override-reason assertions.

### Task 2: Remove Complex Bot Administration and Publish Documentation

**Files:**
- Modify: `packages/koishi-plugin/src/index.ts`
- Modify: `packages/koishi-plugin/test/plugin.test.ts`
- Modify: `packages/koishi-plugin/README.md`
- Modify: `packages/koishi-plugin/package.json`
- Modify: `packages/koishi-plugin/lib/index.js`

**Interfaces:**
- Consumes: Task 1 shortcut registration.
- Produces: published plugin version `0.1.9` without `admin.*` command registration.

- [ ] **Step 1: Write failing removal test**

```ts
expect([...registered.keys()].some((name) => name.startsWith("admin."))).toBe(false);
```

- [ ] **Step 2: Run test to verify RED**

Run: `bun test test/plugin.test.ts --test-name-pattern "registers all player commands"`

Expected: FAIL because current plugin registers five `admin.*` commands.

- [ ] **Step 3: Implement removal and documentation**

Remove the `admin.*` command-registration block, related usage entries, and client/service methods used only by those commands. Keep `staffDenied` and `staffSessionToken`. Replace README's administrator section with the target shortcut list, administrator configuration, and immediate override semantics. Set version to `0.1.9`.

- [ ] **Step 4: Build and verify**

Run:

```bash
bun run typecheck
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0 and `lib/index.js` matches source.

- [ ] **Step 5: Commit**

```bash
git -C packages/koishi-plugin add src/index.ts test/plugin.test.ts README.md package.json lib/index.js
git -C packages/koishi-plugin commit -m "add koishi admin player shortcuts"
```

## Plan Self-Review

- Spec coverage: Task 1 covers every retained command, target authorization, balance adjustment, and immediate override. Task 2 removes complex commands, updates README/version/output, and verifies the plugin.
- Placeholder scan: no command, endpoint, default reason, or permission rule remains undefined.
- Type consistency: target commands use Koishi `user:user`; staff writes resolve a stable PRiSM player ID before staff endpoints.
