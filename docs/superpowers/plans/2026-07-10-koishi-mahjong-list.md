# Koishi Mahjong Seating and Player List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require an entry session before Mahjong seating and render `/list` as grouped, unique players with Mahjong capacity.

**Architecture:** Keep all state in `koishi-plugin-prism`. The plugin reads the existing active-session integration API to validate normal entry and derive billing Mahjong membership, then merges the existing in-memory waiting seats into the list view. No Worker contract, persistence model, or migration changes.

**Tech Stack:** TypeScript, Bun test runner, Koishi plugin API.

## Global Constraints

- Change only `packages/koishi-plugin` production files for this feature.
- A normal entry session has `label === loginSessionLabel`; when that configuration is blank, any active session qualifies.
- Waiting seats are deliberately process-local and do not survive a Koishi restart.
- Keep nickname resolution order: platform resolver, backend display name, identity/player ID fallback.
- Update the plugin README whenever plugin behavior changes.

---

### Task 1: Require Entry Before Mahjong Seating

**Files:**
- Modify: `packages/koishi-plugin/test/plugin.test.ts`
- Modify: `packages/koishi-plugin/src/index.ts:590-634`

**Interfaces:**
- Consumes: `client.listActiveSessions(): Promise<{ sessions: ActiveSessionListItem[] }>` and `loginSessionLabel?: string`.
- Produces: `hasEntrySession(playerId: string, sessions: readonly ActiveSessionListItem[]): boolean` used by `mahjongJoin`.

- [ ] **Step 1: Write the failing test**

Add a test whose mocked active sessions contain another player only, then invoke `上桌 a` without issuing `login`:

```ts
it("rejects mahjong seating before the player enters", async () => {
  const client = createDefaultClient();
  client.listActiveSessions = async () => ({ sessions: [] });
  const registered = new Map<string, RegisteredCommand>();
  applyPrismKoishiPlugin(createMockKoishiContext(registered), mahjongConfig(client));

  await expect(
    registered.get("上桌 <tableId>")?.action(
      { session: { userId: "2034994588", senderName: "hanahana" } },
      "a",
    ),
  ).resolves.toContain("请先入场");
  expect(client.calls.filter((call) => call[0] === "startSessionByIdentity")).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin.test.ts --test-name-pattern "rejects mahjong seating before the player enters"`

Expected: FAIL because `mahjongJoin` currently adds the waiting seat regardless of active sessions.

- [ ] **Step 3: Write minimal implementation**

Before mutating `mahjongTables` in `mahjongJoin`, fetch active sessions and reject when no entry session belongs to the resolved player:

```ts
const activeResult = (await this.client.listActiveSessions()) as UncheckedRecord;
const activeSessions = (activeResult.sessions ?? []) as ActiveSessionListItem[];
if (!this.hasEntrySession(playerId, activeSessions)) {
  return "请先入场后再上桌。";
}
```

Add the private helper:

```ts
private hasEntrySession(playerId: string, sessions: readonly ActiveSessionListItem[]): boolean {
  const label = this.config.loginSessionLabel?.trim();
  return sessions.some((session) =>
    session.playerId === playerId && (label ? session.label === label : true),
  );
}
```

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `bun test test/plugin.test.ts --test-name-pattern "mahjong|rejects mahjong seating"`

Expected: PASS with the pre-entry rejection test and the existing Mahjong join/leave test passing.

- [ ] **Step 5: Commit**

```bash
git -C packages/koishi-plugin add src/index.ts test/plugin.test.ts
git -C packages/koishi-plugin commit -m "require entry before mahjong seating"
```

### Task 2: Group `/list` by Unique Player and Mahjong Table

**Files:**
- Modify: `packages/koishi-plugin/test/plugin.test.ts`
- Modify: `packages/koishi-plugin/src/index.ts:766-788`
- Modify: `packages/koishi-plugin/README.md:11-54`

**Interfaces:**
- Consumes: `ActiveSessionListItem`, `mahjongTableConfigs()`, `mahjongTables`, and `resolvePlatformName(subject)`.
- Produces: `listActiveSessions(sender): Promise<string>` with unique-player total, music group, and non-empty Mahjong groups.

- [ ] **Step 1: Write the failing test**

Add a test with active sessions for five unique players: two music-only players, two players sharing the configured Mahjong label (one also has a music label), and one waiting seat. Assert exact group membership and capacity:

```ts
expect(result).toContain("[总计 5 人]");
expect(result).toContain("🎵 音乐游戏 ( 2人 )：\n- Player 1, - Player 2");
expect(result).toContain("🀄️ 大洋化学八口麻将机 ( 3/4 )：\n- Player 3, - Player 4, - Player 5");
expect(result).not.toContain("音游区间");
```

Configure `resolveDisplayName` to return deterministic player names. Join the fifth player to the table after providing that player an active normal entry session, so the test verifies waiting seats are present without a Mahjong billing session.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin.test.ts --test-name-pattern "groups list by music players and mahjong tables"`

Expected: FAIL because the current formatter counts sessions and emits per-session timestamps.

- [ ] **Step 3: Write minimal implementation**

Replace the session-by-session formatter with these operations:

```ts
const tableByLabel = new Map(
  uniqueMahjongConfigs(this.mahjongTableConfigs()).map((table) => [
    mahjongSessionLabel(table, this.config.mahjongLabelPrefix ?? "麻将桌"),
    table,
  ]),
);
const players = groupSessionsByPlayer(sessions);
const groups = await this.buildPlayerGroups(players, tableByLabel);
this.mergeWaitingSeats(groups);
return formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4);
```

Implement helpers in the same module with explicit responsibilities:

```ts
private async displayNameForPlayer(player: ActivePlayer): Promise<string>
private buildPlayerGroups(players: Map<string, ActivePlayer>, tableByLabel: Map<string, MahjongTableConfig>): Promise<PlayerGroups>
private mergeWaitingSeats(groups: PlayerGroups): void
```

`buildPlayerGroups` assigns a player to the first matching Mahjong session label; otherwise to music. `mergeWaitingSeats` adds a seat only if the player ID is not already counted. `formatPlayerGroups` omits empty Mahjong groups, lists each display as `- ${name}` joined by `, `, and calculates the unique total from all final groups.

- [ ] **Step 4: Update documentation**

Add to the Mahjong feature and command documentation:

```md
`上桌` 仅允许已通过 `login`/`入场` 开启默认入场会话的玩家使用。`list` 会按音乐游戏和麻将桌分组，并对同一玩家的多个计时会话去重；麻将桌显示当前人数和容量。未满桌候座由机器人进程暂存，机器人重启后不会保留。
```

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `bun test test/plugin.test.ts --test-name-pattern "list|mahjong"`

Expected: PASS, including the original list name-resolution tests and new grouping coverage.

- [ ] **Step 6: Run plugin quality gates**

Run:

```bash
bun run typecheck
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0; build regenerates the published `lib` output if it differs from source.

- [ ] **Step 7: Commit**

```bash
git -C packages/koishi-plugin add src/index.ts test/plugin.test.ts README.md lib/index.js lib/index.d.ts
git -C packages/koishi-plugin commit -m "group active players by mahjong table"
```

## Plan Self-Review

- Spec coverage: Task 1 implements the entry-session prerequisite. Task 2 implements unique-player grouping, Mahjong precedence, table capacity, waiting seats, empty-table omission, unchanged display-name resolution, tests, and README synchronization.
- Placeholder scan: no deferred implementation work or unspecified test behavior remains.
- Type consistency: Task 1's `hasEntrySession` consumes the exact active-session type already returned by the plugin client. Task 2's grouping reads the same type and existing table state without introducing a Worker API.
