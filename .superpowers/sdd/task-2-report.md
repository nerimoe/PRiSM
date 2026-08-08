# Task 2 Report: Carry Global Windows Through Checkout Preview

## Scope

- Modified `packages/application/src/settlement.ts`.
- Modified `packages/application/test/settlement.test.ts`.
- Updated `packages/application/test/integration.test.ts`'s typed checkout-preview mock with an empty window list.
- Added this report.
- Did not change checkout totals, settlement adjustments, or persistence.

## Implementation

- `PreviewPlayerCheckoutResult` now exposes `globalCapWindows` as `TimeCapPricingWindow[]`.
- Unified checkout calculation obtains cap-window explanations after cap-history lookup and before applying the existing cap adjustments.
- Preview contributions are sorted by `(sessionId, pricingConfigId)` and allocated proportionally from `amountApplied`; the final contribution receives the residual amount so their sum exactly equals `amountApplied`.

## RED Evidence

Command:

```sh
bun test packages/application/test/settlement.test.ts
```

Result: exit code `1`; 9 passing tests and 1 failing test.

Expected failure from `includes globally capped pricing windows in checkout previews`:

```text
expect(received).toEqual(expected)
+ undefined
```

The new assertion expected `result.globalCapWindows`, which did not exist before the implementation.

## GREEN Evidence

Command:

```sh
bun test packages/application/test/settlement.test.ts
```

Result: exit code `0`; 10 passing tests and 0 failures.

The focused suite includes the existing global-cap settlement coverage and the new preview test. The new test verifies prior history (`paidBefore: 50`), current charges (`currentAmount: 40`), cap (`79`), applied amount (`29`), deterministic contribution order, and exact contribution conservation.

Application typecheck command:

```sh
bun run --cwd packages/application typecheck
```

Result: exit code `0`.

## Notes

- The test fixture sets `sessionId` on its pricing charge, matching the core charge attribution introduced in Task 1.
- The cap-history fixture key uses the core format `cap-config@day@2026-07-09T02:00:00.000Z`.
- Application typechecking requires typed preview mocks to supply the new mandatory field.

## Review Remediation

- Global-cap calculations now receive an application-owned projection of each session result's charge items. When core omits the optional `sessionId`, the projection supplies the enclosing session ID without changing the original preview or persisted charge item.
- Contribution allocation calculates the final contribution from the same left-to-right prefix sum used by JavaScript consumers. This avoids the previous three-way allocation result that reduced to `amountApplied - 0.00000762939453125`.
- Added focused regressions for untagged core charges and the three-contribution floating-point case. The global-cap adjustment calculation, checkout totals, and persistence continue to use their existing paths.

### Remediation Verification

```sh
bun test packages/application/test/settlement.test.ts
bun run --cwd packages/application typecheck
```

Both commands exited `0`: the focused suite has 12 passing tests, including the checkout persistence coverage and both review regressions, and application TypeScript checks pass. The prior allocation arithmetic was independently reproduced as `38633722596.99999 - 38633722597 = -0.00000762939453125`.
