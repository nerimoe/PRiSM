# Design Spec: Checkout Notification Refactoring

Refactoring the settlement process in `koishi-plugin-prism` to extract a common formatting and notification handler, enabling administrator notifications for both `/logout` (regular checkouts) and `/overwrite` (admin price overrides).

## Goals
* Unify the receipt formatting and administrator broadcasting logic.
* Eliminate code duplication between `/logout` and `/overwrite` commands.
* Ensure both commands properly notify all designated administrators via private messages.

## Proposed Changes

### [koishi-plugin-prism](../../../packages/koishi-plugin)

#### [MODIFY] [index.ts](../../../packages/koishi-plugin/src/index.ts)

* Introduce a private helper method `formatAndNotifyCheckout` to format checkout records and broadcast them to configured administrators.
* Modify `performLogout` to delegate formatting and notification to `formatAndNotifyCheckout`.
* Modify `overwriteTargetCheckout` to return the detailed formatted receipt from `formatAndNotifyCheckout` instead of a plain success string.

```typescript
  private async formatAndNotifyCheckout(
    result: UncheckedRecord,
    sender: Sender,
    title: string,
    bot?: KoishiActionContext["session"]["bot"]
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

## Verification Plan

### Automated Tests
* Run `bun test` inside `packages/koishi-plugin` to verify all tests still pass and the logout test suite still verifies receipt broadcasts properly.
* Add or update unit tests to verify that `overwriteTargetCheckout` is now returning the receipt and broadcasting it.
