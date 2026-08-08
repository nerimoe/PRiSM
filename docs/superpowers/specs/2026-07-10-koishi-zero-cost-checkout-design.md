# Koishi Zero-Cost Checkout Display Design

## Scope

Adjust the external `koishi-plugin-prism` checkout display when a player exits
without any charge. This is a presentation-only plugin change; the Worker,
pricing rules, and settlement data remain unchanged.

## Zero-Cost Rule

When every settlement session has a total of zero and there are no non-zero
discount or adjustment entries, the checkout message must omit session labels,
time details, `计费总价`, and `优惠后价格`.

The message format is:

```text
✅ 退场成功 · 结算账单
玩家：月（QQ：1015929452）

本次未产生费用
余额：9791猫粮
```

The balance line is included only when the checkout response contains a
currency balance, matching the existing behavior for balance availability.

## Charged Sessions

Any non-zero session charge or non-zero adjustment continues to use the
current detailed checkout format, including labels, time details, total price,
discounted price when applicable, and `扣款后余额`.

## Tests and Documentation

Add a checkout formatting test for a zero-cost session that has no timestamps,
asserting the concise message and absence of session/total labels. Update the
plugin README to document the concise zero-cost checkout response.
