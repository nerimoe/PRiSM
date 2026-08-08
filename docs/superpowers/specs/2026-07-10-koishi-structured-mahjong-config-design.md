# Koishi Structured Mahjong Configuration Design

## Problem

The current `mahjongTables` configuration is one manually parsed string that
combines table IDs, aliases, display names, and pricing configuration IDs. It
is difficult to edit safely in Koishi's configuration UI.

## Structured Configuration

Add `mahjongTableConfigs` as a Koishi array-of-objects configuration:

```yaml
mahjongTableConfigs:
  - displayName: "🀄️ M.LEAGUE联名比赛专用机"
    aliases: [a, 四麻A, 比赛机]
    pricingConfigIds: [pricing-mahjong-a]
```

`displayName` is the stable internal table key and session label. Every command input,
including the former primary table ID, belongs in `aliases`.

Each table is edited as a native Koishi form card with separate fields for the
display name, command-alias list, and pricing-ID list.

## Compatibility

The existing string `mahjongTables` remains readable as a deprecated fallback.
When `mahjongTableConfigs` is non-empty, it takes precedence. Existing Bot
installations therefore continue working until the operator migrates the
configuration in the UI.

`mahjongTableSize` remains a global capacity setting.

## Implementation and Tests

Normalize structured configuration to the existing `MahjongTableConfig` model,
then reuse all existing join, leave, list, and session-state logic. Tests cover
structured aliases, display names, pricing IDs, precedence over legacy text,
and legacy fallback. README documents the new UI configuration and migration.
