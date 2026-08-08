# Koishi Zero-Cost Checkout Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a concise zero-cost checkout receipt without empty session headings or pricing totals.

**Architecture:** Keep checkout and settlement logic unchanged. The Koishi formatter detects an all-zero, no-adjustment settlement and uses a compact receipt branch; charged or adjusted receipts retain the existing detailed branch.

**Tech Stack:** TypeScript, Bun test runner, Koishi plugin API.

## Global Constraints

- Change only `packages/koishi-plugin` production files.
- A zero-cost receipt has only zero session totals and no non-zero adjustment entries.
- The compact receipt says `本次未产生费用` and uses `余额：<amount><currency>` when a balance exists.
- Do not mention a grace period or change Worker pricing/settlement behavior.
- Preserve the detailed receipt for charged or adjusted sessions.
- Bump the published plugin version from `0.1.7` to `0.1.8`.
- Update the plugin README whenever plugin behavior changes.

---

### Task 1: Format Zero-Cost Checkout Receipts

**Files:**
- Modify: `packages/koishi-plugin/test/plugin.test.ts`
- Modify: `packages/koishi-plugin/src/index.ts:1050-1140`
- Modify: `packages/koishi-plugin/README.md:50-57`
- Modify: `packages/koishi-plugin/package.json`
- Modify: `packages/koishi-plugin/lib/index.js`

**Interfaces:**
- Consumes: `formatCheckoutPreview(result, sender, title)` and its current `sessionPreviews`, adjustments, and asset-holding response shape.
- Produces: the existing `logout(sender): Promise<string>` compact receipt for zero-cost settlements.

- [ ] **Step 1: Write the failing test**

Add a `logout` test with one closed session labelled `音游区间`, no timestamps,
zero subtotal and total, no adjustments, and paid balance `9791`:

```ts
expect(result).toContain("✅ 退场成功 · 结算账单");
expect(result).toContain("本次未产生费用");
expect(result).toContain("余额：9791猫粮");
expect(result).not.toContain("音游区间");
expect(result).not.toContain("计费总价：");
expect(result).not.toContain("扣款后余额：");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin.test.ts --test-name-pattern "renders a concise zero-cost checkout receipt"`

Expected: FAIL because the formatter currently emits the session label, `计费总价：0猫粮`, and `扣款后余额`.

- [ ] **Step 3: Write minimal implementation**

After computing the balance and whether adjustments exist, detect the compact branch and return it before the detailed session rendering:

```ts
const hasNonZeroSessionTotal = sessionPreviews.some((session) =>
  toNumber(session?.total ?? 0) !== 0,
);
const hasNonZeroAdjustment = hasAdjustmentEntries(adjustments, sessionPreviews);
if (!hasNonZeroSessionTotal && !hasNonZeroAdjustment) {
  lines.push("");
  lines.push("本次未产生费用");
  if (hasBalance) lines.push(`余额：${formatNumber(balance)}${currency}`);
  return lines.join("\n");
}
```

Move the existing session-detail loop and pricing lines after this branch. Reuse the same adjustment predicate for `优惠后价格` so the conditions cannot diverge.

- [ ] **Step 4: Update README and build output**

Add this sentence near the player commands:

```md
玩家在未产生任何费用时退场，机器人会简洁显示“本次未产生费用”和当前余额；存在收费或优惠明细时仍显示完整结算账单。
```

Set `package.json` version to `0.1.8`, then run `bun run build` so `lib/index.js` matches `src/index.ts`.

- [ ] **Step 5: Run verification**

Run:

```bash
bun test test/plugin.test.ts --test-name-pattern "zero-cost checkout|multi-session billing"
bun run typecheck
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0, including the compact-receipt regression and existing detailed-billing regression.

- [ ] **Step 6: Commit**

```bash
git -C packages/koishi-plugin add src/index.ts test/plugin.test.ts README.md package.json lib/index.js
git -C packages/koishi-plugin commit -m "format zero cost checkout receipt"
```

## Plan Self-Review

- Spec coverage: the task covers the compact wording, balance label, absence of the old empty fields, detailed-receipt preservation, README, generated package output, and verification.
- Placeholder scan: no deferred work or ambiguous conditions remain.
- Type consistency: the plan uses the existing formatter and response types without adding a Worker contract.
