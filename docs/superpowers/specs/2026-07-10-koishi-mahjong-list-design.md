# Koishi Mahjong Seating and Player List Design

## Scope

Update the external `koishi-plugin-prism` repository so Mahjong seating requires
an existing normal entry session and `/list` represents players rather than raw
active sessions. This change does not add Worker APIs, database tables, or
migrations.

## Data Sources

The plugin continues to use `GET /rpc/integration/sessions/active`. Each active
session supplies a player ID, label, identities, and a backend display name.
The plugin's existing in-memory `mahjongTables` map remains the source of truth
for players who have selected a table but whose table has not reached its
configured capacity.

As a result, waiting seats intentionally do not survive a Koishi process
restart. This is an accepted limitation of the selected plugin-only approach.

## Entry Requirement

Before adding a player to a Mahjong table, the plugin fetches active sessions
and requires an active session for that player whose label exactly equals the
configured `loginSessionLabel`. An empty `loginSessionLabel` disables that
label-specific requirement and accepts any active session as an entry session.

If the player is not entered, the command leaves table state unchanged and
returns an instruction to enter first.

## List Grouping

`/list` fetches active sessions once, then builds a unique-player view:

- A player with one or more active sessions matching a configured Mahjong
  table label belongs to that table. Matching is based on the table's effective
  session label: `displayName`, or `${mahjongLabelPrefix} ${tableId}` when no
  display name is configured.
- A player without an active Mahjong session belongs to the music-game group,
  even when that player has multiple normal active sessions.
- For each configured table, in-memory waiting seats are added when that
  player is not already represented by an active Mahjong session. Empty tables
  are omitted.
- A player is displayed once only. Active Mahjong membership takes precedence
  over normal music-game membership.

The player total counts the final unique players across the music-game group
and non-empty Mahjong groups. Display names continue to prefer the configured
platform-name resolver, then the backend display name, with the existing
identity fallback.

## Output

The list uses this shape, with blank lines between non-empty groups:

```text
[总计 7 人]
🎵 音乐游戏 ( 2人 )：
- 玩家A, - 玩家B

🀄️ 大洋化学八口麻将机 ( 4/4 )：
- 玩家C, - 玩家D, - 玩家E, - 玩家F
```

Each Mahjong heading uses its configured display name and shows its current
occupied count against `mahjongTableSize`. Waiting and billing players both
count toward the occupied count.

## Tests and Documentation

Plugin tests will cover refusal before entry, grouping active Mahjong sessions,
merging waiting seats, unique player totals, and omission of empty tables. The
plugin README will document the entry prerequisite, list grouping behavior, and
the restart limitation for waiting seats.
