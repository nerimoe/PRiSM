# Pre-merge server API regression contract

The compatibility baseline is `7fd7e7c` (the `main` parent of unified server PR #11).
This document is a regression inventory, not permission to deploy without full CI
and a real-device Live Activity check.

## Required public paths

- `/api/v1/shops/:shopCode/player/live-activity/bill` (`GET`, including
  `sessionId` to recover a previously paid visit)
- `/api/v1/shops/:shopCode/player/live-activity/register` (`POST`)
- `/api/v1/shops/:shopCode/player/live-activity/unregister` (`POST`)
- `/api/v1/shops/:shopCode/staff/settings` (`GET`, `PUT`)
- `/api/v1/shops/:shopCode/staff/api-tokens` (`GET`, `POST`)
- `/api/v1/shops/:shopCode/staff/api-tokens/:tokenId/revoke` (`POST`)
- `/api/v1/shops/:shopCode/staff/users` (`GET`, `POST`)
- `/api/v1/shops/:shopCode/staff/users/:staffUserId` (`PATCH`)
- `/api/v1/shops/:shopCode/staff/users/:staffUserId/password` (`POST`)
- `/api/v1/shops/:shopCode/integration/players/by-identity/checkout/override` (`POST`)
- `/api/v1/shops/:shopCode/integration/players/by-identity/device-actions` (`POST`)
- `/api/*` aliases rewrite to `/api/v1/*` and expose the unwrapped legacy
  success and string error shapes.

The production `createApp().routes` inventory is asserted in
`packages/server/test/shop-billing-routes.test.ts`. The true contract requires
behavioural assertions as well as registration: these paths must enforce
shop-scoped authentication and return the original response types.

## Live Activity delivery

Pre-refactor `packages/platform/src/live-activity-events.ts` drove
push-to-start, per-activity updates and end signals for player, staff and
integration session mutations. The equivalent shop mutation bridge is now
`packages/server/src/routes/shops/index.ts`, with event logic in
`live-activity-events.ts` and the original APNs push utilities under
`durable-objects/`. Cached idempotent responses must **not** trigger another
APNs notification. An APNs transport stub tests ActivityKit payload shape and
the database token lifecycle in `live-activity-push-flow.test.ts`.

Account start-token registration is different from activity-token registration:
`POST /api/v1/me/live-activity/start-token` registers a device's remote launch
token, whereas `POST /api/v1/shops/:shopCode/player/live-activity/register`
registers a particular running activity for update and end pushes.
Both are necessary.

## Transactional and safety boundaries

- Player entry requires a valid shop-scoped QR ticket, `consent:true`, and
  check-in location when configured. The tenant dependency's `startSession`
  already performs the leased, shop-priced entry operation: do not nest another
  `player.entry` lease around it.
- Player checkout requires the checkout location outside the configured
  geofence; arbitrary player device commands are forbidden in favour of the
  QR-scoped machine-session actions.
- Financial player/staff operations use `runPlayerOperation` with a UUID
  `operationId`; repeated requests return the stored result rather than
  mutating the wallet again.
- Player list results keep `walletTotal` (displayed in yuan), session state,
  and both store identity and account-derived `web-account` bindings.

## CI

The Bun suite verifies historical route inventory, real production route
responses, QR rejection, wallet values and idempotent replays, activity-token
registration/retirement and APNs push fanout. The browser matrix runs Chromium
and WebKit at mobile and desktop widths for player balances and full role
navigation. WebKit is an approximation, not a substitute for real iPhone
ActivityKit/APNs testing.
