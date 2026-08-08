# Checkout Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor checkout notifications in the Koishi plugin to send bills/receipts to administrators on both standard logouts and manual price overwrites.

**Architecture:** Extract the receipt formatting and administrator broadcasting logic from `performLogout` into a reusable private helper method `formatAndNotifyCheckout` in `PrismKoishiService`. Update `performLogout` and `overwriteTargetCheckout` to call this helper.

**Tech Stack:** TypeScript, Bun (test runner), Koishi.

## Global Constraints
* Indentation style: Two-space indentation.
* Code style: Strict TypeScript.
* Git guidelines: Keep commits concise and scope-focused.

---

### Task 1: Implement `formatAndNotifyCheckout` and refactor `performLogout`

**Files:**
* Modify: `packages/koishi-plugin/src/index.ts`

**Interfaces:**
* Consumes: `this.formatCheckoutPreview` and `this.config`
* Produces: `private async formatAndNotifyCheckout(result: UncheckedRecord, sender: Sender, title: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string>`

- [ ] **Step 1: Write the helper function and update `performLogout`**

Edit `packages/koishi-plugin/src/index.ts`. Replace `performLogout` with the extracted helper `formatAndNotifyCheckout` and the simplified `performLogout` method.

Code to add/modify:
```typescript
  private async performLogout(sender: Sender, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    const result = (await this.client.confirmCheckoutByIdentity(this.identity(sender), false)) as UncheckedRecord;
    return this.formatAndNotifyCheckout(result, sender, "✅ 退场成功 · 结算账单", bot);
  }

  private async formatAndNotifyCheckout(
    result: UncheckedRecord,
    sender: Sender,
    title: string,
    bot?: KoishiActionContext["session"]["bot"],
  ): Promise<string> {
    const settlement = result?.playerSettlement ?? result?.settlement ?? {};
    const records = result?.settlements ?? [];
    const checkoutAdjustments = (result?.checkoutAdjustments ?? []) as UncheckedRecord[];
    const pricingCapAdjustments = (result?.pricingCapAdjustments ?? []) as UncheckedRecord[];
    const checkoutAdjustmentKeys = new Set(checkoutAdjustments.map(adjustmentKey));
    const pricingCapAdjustmentKeys = new Set(pricingCapAdjustments.map(adjustmentKey));
    const sessionPreviews = records.map((rec: UncheckedRecord) => {
      const s = rec?.settlement ?? {};
      const sessionAdjustments = ((rec?.adjustments ?? []) as UncheckedRecord[]).filter((adjustment) => {
        const key = adjustmentKey(adjustment);
        return !checkoutAdjustmentKeys.has(key) &&
          !pricingCapAdjustmentKeys.has(key) &&
          !isPricingCapAdjustment(adjustment);
      });
      const sessionSubtotal = toNumber(s.subtotal ?? 0);
      return {
        sessionId: s.sessionId,
        label: s.label,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? s.settledAt,
        status: "closed",
        subtotal: sessionSubtotal,
        total: Math.max(0, sessionSubtotal + sessionAdjustments.reduce(
          (sum, adjustment) => sum + toNumber(adjustment?.amount ?? 0),
          0,
        )),
        chargeItems: rec?.chargeItems ?? [],
        adjustments: sessionAdjustments,
      };
    });
    const synthetic = {
      settlement: {
        playerId: settlement.playerId,
        subtotal: settlement.subtotal ?? 0,
        total: settlement.total ?? 0,
      },
      sessionPreviews,
      chargeItems: result?.chargeItems ?? [],
      adjustments: result?.adjustments ?? [],
      checkoutAdjustments,
      pricingCapAdjustments,
      globalCapWindows: result?.globalCapWindows ?? [],
      assetHoldings: result?.assetHoldings ?? [],
    };
    const receipt = await this.formatCheckoutPreview(synthetic, sender, title);
    const recipients = [...new Set([...(this.config.staffUserIds ?? []), ...(this.config.logoutNotifyUserIds ?? [])])];
    if (recipients.length > 0 && bot?.broadcast) {
      await bot.broadcast(recipients, receipt);
    }
    return receipt;
  }
```

- [ ] **Step 2: Run tests to verify `logout` command still passes**

Run: `bun test test/plugin.test.ts` inside `packages/koishi-plugin` (or workspace root `koishi-plugin-prism`)
Expected output: All existing tests pass, specifically `quotes command replies and notifies configured logout recipients`.

- [ ] **Step 3: Commit the changes**

```bash
git add src/index.ts
git commit -m "refactor: extract formatAndNotifyCheckout helper"
```

---

### Task 2: Refactor `overwriteTargetCheckout` and add price overwrite notification test

**Files:**
* Modify: `packages/koishi-plugin/src/index.ts`
* Modify: `packages/koishi-plugin/test/plugin.test.ts`

**Interfaces:**
* Consumes: `this.formatAndNotifyCheckout`
* Produces: `async overwriteTargetCheckout(actor: Sender, targetSubject: string, rawAmount: string, rawReason?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string>`

- [ ] **Step 1: Refactor `overwriteTargetCheckout`**

Edit `packages/koishi-plugin/src/index.ts`. Update `overwriteTargetCheckout` to:
```typescript
  async overwriteTargetCheckout(actor: Sender, targetSubject: string, rawAmount: string, rawReason?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender) => {
      const total = Number(rawAmount);
      if (!Number.isFinite(total) || total < 0) return "金额必须为非负数";
      const reason = cleanText(rawReason) || "Koishi 管理员手动调价";
      const result = (await this.client.checkoutWithOverrideByIdentity(this.identity(sender), total, reason)) as UncheckedRecord;
      return this.formatAndNotifyCheckout(result, sender, "✅ 覆盖结账成功 · 结算账单", bot);
    }, bot);
  }
```

- [ ] **Step 2: Add test case for overwrite command notification**

Edit `packages/koishi-plugin/test/plugin.test.ts`. Locate the test `quotes command replies and notifies configured logout recipients` and add a new test block next to it or update the test suite to verify overwrite notification. Let's add a new test case:

```typescript
  it("notifies configured logout recipients when overwrite command is executed", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const broadcasts: Array<[string[], string]> = [];
    applyPrismKoishiPlugin(createMockKoishiContext(registered), {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      staffUserIds: ["staff-1"],
      logoutNotifyUserIds: ["staff-1", "audit-1"],
      client: client as any,
    });
    const bot = {
      async broadcast(userIds: string[], content: string) {
        broadcasts.push([userIds, content]);
      },
    };

    client.checkoutWithOverrideByIdentity = async () => {
      return {
        playerSettlement: { playerId: "player-1", subtotal: 10, total: 30, status: "settled", settledAt: new Date() },
        settlements: [],
        assetHoldings: [],
      };
    };

    const overwriteResult = await registered.get("overwrite <target:user> <amount:number> [reason:text]")?.action({
      session: { userId: "staff-1", senderName: "Admin", messageId: "message-3", bot },
    }, "target-qq", "30");

    expect(overwriteResult).toContain("quote");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0][0]).toEqual(["staff-1", "audit-1"]);
    expect(broadcasts[0][1]).toContain("✅ 覆盖结账成功 · 结算账单");
    expect(broadcasts[0][1]).not.toContain("quote");
  });
```

- [ ] **Step 3: Run tests to verify all tests pass**

Run: `bun test test/plugin.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit and finalize**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: notify administrators on overwrite price settlement"
```
