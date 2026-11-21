import { describe, expect, it } from "bun:test";
import { botMessageText } from "@prism/core";
import { rosterMessage, type Roster } from "../src/resources/roster.js";

const member = (playerId: string) => ({ playerId, displayName: playerId.toUpperCase(), identities: [], since: new Date(0) });

describe("what a bot says for a roster", () => {
  it("lists the shop at its resources and everyone else together, each player a segment", () => {
    const roster: Roster = {
      total: 3,
      groups: [
        { kind: "resource", id: "m1", name: "舞萌", capacity: 2, members: [member("a")] },
        { kind: "plan", id: "p1", name: "普通", members: [member("b")] },
        { kind: "plan", id: "p2", name: "通宵", members: [member("c")] },
      ],
    };
    const message = rosterMessage(roster);
    expect(botMessageText(message)).toBe("[总计 3 人]\n\n舞萌 ( 1/2 )：\n- A\n\n其他 ( 2人 )：\n- B, - C");
    expect(message.filter((segment) => "player" in segment)).toEqual([
      { player: { playerId: "a", displayName: "A", identities: [] } },
      { player: { playerId: "b", displayName: "B", identities: [] } },
      { player: { playerId: "c", displayName: "C", identities: [] } },
    ]);
  });

  it("lists a plan asked for by name under its own name, and says when it is empty", () => {
    expect(botMessageText(rosterMessage({ total: 1, groups: [{ kind: "plan", id: "p1", name: "普通", members: [member("b")] }] }, true)))
      .toBe("[总计 1 人]\n\n普通 ( 1人 )：\n- B");
    expect(botMessageText(rosterMessage({ total: 0, groups: [{ kind: "resource", id: "m1", name: "舞萌", capacity: 2, members: [] }] }, true)))
      .toBe("舞萌 ( 0/2 )");
    expect(botMessageText(rosterMessage({ total: 0, groups: [] }))).toBe("🫥 窝里目前没有玩家呢");
  });
});
