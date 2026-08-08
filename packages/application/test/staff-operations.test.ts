import { describe, expect, it } from "bun:test";
import { createStaffOperationsService } from "../src/staff-operations";

describe("createStaffOperationsService", () => {
  it("checks out each active player once even when they have multiple sessions", async () => {
    const checkedOut: string[] = [];
    const service = createStaffOperationsService({
      staffQueries: {
        async listPlayers() {
          return [];
        },
        async listActiveSessions() {
          return [
            activeSession("session-1", "player-1"),
            activeSession("session-2", "player-1"),
            activeSession("session-3", "player-2"),
          ];
        },
      },
      checkout: {
        async checkout({ playerId }) {
          checkedOut.push(playerId);
          return { playerId };
        },
      },
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });

    await expect(service.checkoutAllActivePlayers()).resolves.toEqual([
      { playerId: "player-1" },
      { playerId: "player-2" },
    ]);
    expect(checkedOut).toEqual(["player-1", "player-2"]);
  });
});

function activeSession(id: string, playerId: string) {
  return {
    id,
    playerId,
    playerDisplayName: playerId,
    startedAt: new Date("2026-07-16T09:00:00.000Z"),
    elapsedMinutes: 60,
  };
}
