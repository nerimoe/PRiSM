# Koishi Mahjong Table State Synchronization Design

## Problem

The plugin currently treats its process-local `mahjongTables.activeSessions`
map as authoritative. A player can settle or stop a Mahjong session through a
different route, leaving stale session IDs in that map. `/list` reads backend
active sessions and reports the table as empty, while `/上桌` reads stale
memory and rejects new players as if the table were still billing.

## Source of Truth

Backend active sessions are the source of truth for started Mahjong tables.
The plugin derives each table's active player-to-session-ID map by matching
active session labels to configured Mahjong table labels.

The process-local `waiting` seats remain the source of truth only for tables
that have not started billing. Waiting seats intentionally do not survive a
Koishi restart.

## Synchronization

Add `syncMahjongTableStates(activeSessions)`:

1. Build a map from every configured effective Mahjong label to its table.
2. Rebuild each table's `activeSessions` from matching backend active sessions.
3. Remove stale in-memory active session IDs by replacing, rather than merging,
   every table's active-session map.
4. Preserve `waiting` seats unless their player now has an active Mahjong
   session for that same table.

`/list` fetches active sessions and synchronizes before grouping output.
`/上桌` reuses its existing active-session fetch to synchronize before checking
whether the requested table is already billing. `/下桌` fetches and
synchronizes first, allowing it to recover the correct session ID after a Bot
restart.

## Outcomes

- An externally settled Mahjong table becomes available on the next `/上桌`
  without restarting Koishi.
- A restarted Bot can discover an already-started table and process `/下桌`.
- `/list`, `/上桌`, and `/下桌` use the same backend-derived started-table
  state.
- Empty tables remain omitted from `/list`; unfinished waiting seats retain
  their documented restart limitation.

## Tests and Documentation

Tests cover stale memory cleanup, started-table reconstruction after restart,
and down-table session stopping from reconstructed state. README distinguishes
backend-recovered billing tables from process-local waiting seats.
