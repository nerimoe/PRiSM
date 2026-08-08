# Koishi Administrator Shortcut Commands Design

## Scope

Update the external `koishi-plugin-prism` so configured administrators can
operate a mentioned player from chat. Retain operational shortcuts only; remove
the plugin's existing complex `admin.*` commands because equivalent management
work belongs in the web dashboard.

## Administrator Authorization

An administrator is a Koishi platform user whose ID appears in
`staffUserIds`, with `enableStaffCommands` enabled. Administrator commands
that write staff-owned state additionally use the configured
`staffSessionToken` to call staff RPC endpoints.

Non-administrators may operate only their own identity. Supplying a target
mention as a non-administrator returns the existing permission-denied result.

## Command Set

The plugin provides these operational commands, accepting a Koishi
`user:user` mention as the optional or required target:

```text
login [@玩家]
入场 [@玩家]
logout [@玩家]
billing [@玩家]
wallet [@玩家]
items [@玩家]
history [@玩家]
add @玩家 <金额>
del @玩家 <金额>
overwrite @玩家 <金额> [原因]
```

The optional-target commands act on the invoking user when no target is given.
With a target, they require administrator authorization. Player identity
resolution uses the existing configured provider and targeted platform subject.

`add` and `del` use staff asset adjustment APIs to change the target's paid
currency by a positive or negative amount. They require a target and a
non-zero numeric amount.

## Override Semantics

PRiSM Next has no deferred session-cost overwrite. `overwrite` maps to the
staff checkout override endpoint, immediately settling all eligible sessions
for the target at the supplied total. Its optional reason defaults to
`Koishi 管理员手动调价` so staff audit records always have a reason.

## Removed Commands

Remove these existing Bot commands and their command-usage entries:

```text
admin.players
admin.create-player
admin.grant-balance
admin.redeem-code
admin.checkout
```

Do not port the old plugin's assets, coupons, gifts, redemption-code, pricing,
or other dashboard-management commands.

## Testing and Documentation

Tests cover registration/removal of commands, self-service behavior, admin
target behavior, non-admin target rejection, targeted balance adjustment, and
immediate override checkout with default and explicit reasons. README documents
administrator configuration, the retained shortcut commands, and override's
immediate-settlement behavior.
