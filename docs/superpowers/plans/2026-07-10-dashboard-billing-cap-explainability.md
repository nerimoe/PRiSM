# Dashboard Billing Cap Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live-player bills fully explain per-rule intervals, interval caps, and multi-day global cap windows, while adding per-code clipboard copying in the Dashboard.

**Architecture:** Preserve the existing pricing and settlement order, but make the pricing engine expose structured explanation results alongside its existing charge and adjustment results. The application checkout preview carries those results to `/rpc/staff/live-players`; Hono serializes a Dashboard-oriented read model. Flutter renders the returned segments and windows verbatim, retaining expansion state by stable IDs rather than re-deriving pricing locally.

**Tech Stack:** Bun, strict TypeScript, Hono, Flutter Web, Riverpod, Freezed/json_serializable, Flutter widget tests.

## Global Constraints

- Do not change settlement ordering: interval caps, then global caps, then asset effects and staff overrides.
- Represent caps as final capped amounts, never as a customer-facing negative discount.
- Include every pricing segment and every global cap window; do not truncate multi-day sessions.
- Dashboard must not calculate time boundaries, cap windows, or cap allocations from raw numbers.
- Preserve `pricingCharges` in the staff read model for existing consumers.
- Use `YYYY-MM-DD HH:mm 至 YYYY-MM-DD HH:mm · 时长` for actual segment windows.
- Only show `区间内封顶 ¥金额 · 已达到` when the interval cap is reached.
- Update `docs/api.md` and `docs/architecture.md` with the implemented contract.

---

## File Structure

- `packages/core/src/pricing-time.ts`: exposes structured interval and global-cap explanation data from the same time-boundary calculations used for pricing.
- `packages/core/src/settlement.ts`: carries optional pricing explanation metadata on `ChargeItem` and structured global window results.
- `packages/core/test/pricing-time.test.ts`: proves interval and cap-window calculations across day boundaries.
- `packages/application/src/settlement.ts`: retains global-cap explanations in a player checkout preview.
- `packages/application/test/settlement.test.ts`: proves amount conservation and history-aware global cap windows.
- `packages/server-hono/src/index.ts`: maps preview explanations into the `live-players` response.
- `packages/server-hono/test/app.test.ts`: asserts the route response includes the new read model while retaining `pricingCharges`.
- `packages/prism-dashboard/lib/src/api/models.dart`: Freezed models for segments and global cap windows.
- `packages/prism-dashboard/lib/src/features/operations/operations_screen.dart`: session-summary table, persistent expansion state, interval rows, and global-window list.
- `packages/prism-dashboard/lib/src/features/assets/assets_screen.dart`: clipboard action and feedback for each redeem code.
- `packages/prism-dashboard/test/live_operations_test.dart`: JSON parsing and persistent expanded bill rendering.
- `packages/prism-dashboard/test/assets_screen_test.dart`: redeem-code copy affordance and feedback.
- `docs/api.md`, `docs/architecture.md`: public contract and architecture documentation.

### Task 1: Expose Pricing Explanations in Core

**Files:**
- Modify: `packages/core/src/settlement.ts`
- Modify: `packages/core/src/pricing-time.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/pricing-time.test.ts`

**Interfaces:**
- Produces `PricingSegmentExplanation` on each priority-time `ChargeItem` with `pricingConfigId`, `providerId`, `ruleId`, `ruleLabel`, `period`, `ruleTimeRange`, `intervalCap`, and `intervalCapReached`.
- Produces `TimeCapPricingWindow` with stable key, cap config/rule metadata, `windowStartedAt`, `windowEndedAt`, `paidBefore`, `currentAmount`, `amountApplied`, `priceCap`, and per-session contribution amounts.
- `applyTimeCapPricing()` derives adjustments from `TimeCapPricingWindow[]`; it must retain its current adjustment behavior exactly.

- [ ] **Step 1: Write failing core tests for segment explanations and cap windows**

```ts
test("records the actual overnight segment and reached interval cap", () => {
  const charges = createPriorityTimePricingProvider(config).quote({
    session: { id: "s1", startedAt: new Date("2026-07-09T13:48:00Z"), ...session },
    now: new Date("2026-07-10T02:00:00Z"),
    assetHoldings: [],
  });
  expect(charges[1].pricingExplanation).toMatchObject({
    ruleLabel: "平日夜场",
    period: { startedAt: new Date("2026-07-09T14:00:00Z") },
    intervalCap: 100,
    intervalCapReached: true,
  });
});

test("keeps one global cap window per local rule anchor across multiple sessions", () => {
  const windows = explainTimeCapPricing({ config, chargeItems, paidHistory: {} });
  expect(windows).toEqual([expect.objectContaining({
    ruleLabel: "夜间", currentAmount: 100, priceCap: 79, amountApplied: 79,
    contributions: [expect.objectContaining({ sessionId: "s1" })],
  })]);
});
```

- [ ] **Step 2: Run the new core test to verify it fails**

Run: `bun test packages/core/test/pricing-time.test.ts`

Expected: FAIL because `pricingExplanation` and `explainTimeCapPricing` do not exist.

- [ ] **Step 3: Add minimal core explanation types and calculation**

```ts
export type PricingSegmentExplanation = {
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleLabel: string;
  period: { startedAt: Date; endedAt: Date };
  ruleTimeRange: TimeRange | null;
  intervalCap: number;
  intervalCapReached: boolean;
};

export type TimeCapPricingWindow = {
  key: string;
  capConfigId: string;
  capRuleId: string;
  ruleLabel: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  priceCap: number;
  paidBefore: number;
  currentAmount: number;
  amountApplied: number;
  contributions: Array<{ sessionId: string; pricingConfigId: string; amount: number }>;
};
```

Attach the segment explanation when `createPriorityTimePricingProvider()` creates a charge. Extract the existing `applyTimeCapPricing()` bucket loop into `explainTimeCapPricing()`; use the same `findActiveRule`, priority-boundary, rule-anchor, and `calculateCapWindowTarget` helpers. Make `applyTimeCapPricing()` map only windows with a nonzero adjustment back to `SettlementAdjustment`, preserving `pricingCapHistory` values.

- [ ] **Step 4: Run focused core tests and the existing pricing suite**

Run: `bun test packages/core/test/pricing-time.test.ts packages/core/test/settlement.test.ts`

Expected: PASS with existing behavior unchanged and new explanation assertions green.

- [ ] **Step 5: Commit the core change**

```bash
git add packages/core/src packages/core/test/pricing-time.test.ts
git commit -m "explain time pricing caps"
```

### Task 2: Carry Global Windows Through Checkout Preview

**Files:**
- Modify: `packages/application/src/settlement.ts`
- Modify: `packages/application/test/settlement.test.ts`

**Interfaces:**
- Extends `PreviewPlayerCheckoutResult` with `globalCapWindows: TimeCapPricingWindow[]`.
- Each returned window has contributions whose `amount` values sum to its `amountApplied` after deterministic proportional allocation; the last contribution receives the remainder to avoid floating-point drift.

- [ ] **Step 1: Write failing application tests for preview window history and conservation**

```ts
expect(result.globalCapWindows).toEqual([
  expect.objectContaining({ paidBefore: 50, currentAmount: 40, priceCap: 79, amountApplied: 29 }),
]);
expect(result.globalCapWindows[0].contributions.reduce((sum, item) => sum + item.amount, 0))
  .toBe(result.globalCapWindows[0].amountApplied);
```

- [ ] **Step 2: Run the focused application test to verify it fails**

Run: `bun test packages/application/test/settlement.test.ts`

Expected: FAIL because checkout previews do not expose global cap windows.

- [ ] **Step 3: Add global windows to unified checkout details and preview**

Call `explainTimeCapPricing()` after the existing history lookup, before `applyTimeCapPricing()`. Store windows in `calculateUnifiedCheckoutDetails()`, return them from `toPlayerCheckoutPreview()`, and allocate `amountApplied` over contributing session IDs in a stable `(sessionId, pricingConfigId)` order. Do not alter adjustment persistence or settlement totals.

- [ ] **Step 4: Run focused and full application settlement tests**

Run: `bun test packages/application/test/settlement.test.ts`

Expected: PASS, including the existing `applies global time caps` test.

- [ ] **Step 5: Commit the application change**

```bash
git add packages/application/src/settlement.ts packages/application/test/settlement.test.ts
git commit -m "include cap windows in checkout previews"
```

### Task 3: Extend the Staff Live-Player Read Model

**Files:**
- Modify: `packages/server-hono/src/index.ts`
- Modify: `packages/server-hono/src/types.ts`
- Modify: `packages/server-hono/test/app.test.ts`

**Interfaces:**
- `LiveSessionView.pricingSegments` returns server-formatted ISO dates, rule metadata, `amount`, `intervalCap`, and `intervalCapReached`.
- `LivePlayerView.globalCapWindows` returns all player preview windows with cap metadata, ISO window dates, `paidBefore`, `currentAmount`, `amountApplied`, and contributing session IDs.
- Existing `pricingCharges` remains unchanged.

- [ ] **Step 1: Write a failing route test**

```ts
const body = await app.request("/rpc/staff/live-players", staffAuth);
const player = (await body.json()).players[0];
expect(player.sessions[0].pricingSegments[0]).toMatchObject({
  ruleLabel: "平日夜场", intervalCap: 100, intervalCapReached: true,
});
expect(player.globalCapWindows[0]).toMatchObject({
  ruleLabel: "夜间", priceCap: 79, amountApplied: 79,
});
expect(player.sessions[0].pricingCharges).toHaveLength(1);
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `bun test packages/server-hono/test/app.test.ts`

Expected: FAIL because `pricingSegments` and `globalCapWindows` are absent.

- [ ] **Step 3: Serialize the new preview fields without front-end derivation**

Add explicit view helpers adjacent to `pricingChargesForSession()`. Build segments from the corresponding `sessionPreview.chargeItems`, sort by `period.startedAt`, and emit every item with a pricing explanation. Map preview windows to player rows after mapping sessions; use the core-provided session contributions rather than recalculating allocation in Hono.

- [ ] **Step 4: Run Hono tests**

Run: `bun test packages/server-hono/test/app.test.ts`

Expected: PASS with legacy `pricingCharges` assertions still green.

- [ ] **Step 5: Commit the read-model change**

```bash
git add packages/server-hono/src/index.ts packages/server-hono/src/types.ts packages/server-hono/test/app.test.ts
git commit -m "expose live bill pricing explanations"
```

### Task 4: Render the Structured Bill and Copy Redeem Codes

**Files:**
- Modify: `packages/prism-dashboard/lib/src/api/models.dart`
- Modify: generated `packages/prism-dashboard/lib/src/api/models.freezed.dart`
- Modify: generated `packages/prism-dashboard/lib/src/api/models.g.dart`
- Modify: `packages/prism-dashboard/lib/src/features/operations/operations_screen.dart`
- Modify: `packages/prism-dashboard/lib/src/features/assets/assets_screen.dart`
- Modify: `packages/prism-dashboard/test/live_operations_test.dart`
- Modify: `packages/prism-dashboard/test/assets_screen_test.dart`

**Interfaces:**
- Adds `LivePricingSegment` and `LiveGlobalCapWindow` Freezed models; `LivePlayer` gains `@Default([]) List<LiveGlobalCapWindow> globalCapWindows`, and `LiveSession` gains `@Default([]) List<LivePricingSegment> pricingSegments`.
- `_SessionTable` receives `Set<String> expandedSessionIds` and an `onToggleSession(String)` callback from `_OperationsScreenState`.

- [ ] **Step 1: Write failing Flutter model and widget tests**

```dart
expect(player.sessions.single.pricingSegments.single.actualStartedAt,
    DateTime.parse('2026-07-09T14:00:00.000Z'));
expect(find.textContaining('实际计费：2026-07-09'), findsOneWidget);
expect(find.text('区间内封顶 ¥100 · 已达到'), findsOneWidget);
expect(find.text('2026-07-09 夜间'), findsOneWidget);

await tester.tap(find.byTooltip('复制兑换码'));
await tester.pump();
expect(find.text('兑换码已复制。'), findsOneWidget);
```

Add a refresh test that expands a session, triggers the existing refresh control, and confirms the same session detail remains visible. Add JSON fixtures with multiple cap windows and all interval segments; do not use a truncated fixture.

- [ ] **Step 2: Run Flutter tests to verify they fail**

Run: `flutter test test/live_operations_test.dart test/assets_screen_test.dart`

Expected: FAIL because models, interval rows, cap windows, and copy control are absent.

- [ ] **Step 3: Implement models and regenerate serializers**

Define the new Freezed models with `DateTime` fields and safe empty defaults. Regenerate only model artifacts:

```bash
dart run build_runner build --delete-conflicting-outputs
```

- [ ] **Step 4: Implement the bill UI and clipboard action**

Replace the current inline `_PricingChargeList` in `_SessionTable` with a compact session summary and controlled expandable detail. Render every `pricingSegments` element in the fixed four-part format. Show the interval-cap badge only when `intervalCapReached` is true. Below the session table, render every `globalCapWindows` element as a controlled expandable window with full date range, participants, and `参与金额 -> 封顶金额` or `参与金额 -> 当前计入金额` wording.

Keep expanded IDs in `_OperationsScreenState`; never clear that set during `_refresh()` or `_load()`. Import `package:flutter/services.dart` in `assets_screen.dart`, add an icon-only `Icons.content_copy_outlined` button with `tooltip: '复制兑换码'`, call `Clipboard.setData`, and show `SnackBar(content: Text('兑换码已复制。'))`.

- [ ] **Step 5: Run Dashboard tests and analysis**

Run: `flutter test test/live_operations_test.dart test/assets_screen_test.dart`

Expected: PASS with exact interval text, preserved expansion state, all cap windows, and clipboard feedback covered.

Run: `flutter analyze`

Expected: exit code 0.

- [ ] **Step 6: Commit the Dashboard change**

```bash
git add packages/prism-dashboard/lib packages/prism-dashboard/test
git commit -m "explain caps in dashboard bills"
```

### Task 5: Synchronize Documentation and Run Repository Verification

**Files:**
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write documentation assertions into the existing route and Dashboard tests**

Extend the Task 3 route test to assert the documented fields and the Task 4 widget test to assert the documented cap wording. This makes the API documentation claims executable behavior.

- [ ] **Step 2: Update API and architecture documentation**

Document `pricingSegments` and `globalCapWindows` under `/rpc/staff/live-players`, including complete ISO timestamp semantics, interval-cap visibility, cap-window grouping, history-aware values, and preserved `pricingCharges`. Update the architecture description of global caps to state that staff presentation groups them by anchored cap window and renders the capped final amount, not the adjustment delta. Document per-code clipboard copying in the Dashboard asset-and-gifts description.

- [ ] **Step 3: Run targeted documentation-adjacent tests**

Run: `bun test packages/server-hono/test/app.test.ts && flutter test test/live_operations_test.dart test/assets_screen_test.dart`

Expected: all selected tests pass.

- [ ] **Step 4: Run required repository verification**

Run: `bun test`

Expected: exit code 0 with no test failures.

Run: `bun run typecheck`

Expected: exit code 0.

Run: `bun run admin-flutter:analyze && bun run admin-flutter:test`

Expected: exit code 0.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/api.md docs/architecture.md
git commit -m "document live bill cap explanations"
```
