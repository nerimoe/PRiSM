import { describe, expect, it } from "bun:test";
import type { Player, PlayerIdentityRepository, PlayerRepository, PlayerSession, PlayerSessionRepository } from "@prism/core";
import { createPlayerAuthService } from "../src/index";

class MemoryPlayerRepository implements PlayerRepository {
  players = new Map<string, Player>();

  async findById(playerId: string): Promise<Player | null> {
    return this.players.get(playerId) ?? null;
  }

  async listPlayers(): Promise<Player[]> {
    return [...this.players.values()];
  }

  async save(player: Player): Promise<void> {
    this.players.set(player.id, player);
  }

  async updateStatus(playerId: string, status: Player["status"]): Promise<void> {
    const player = this.players.get(playerId);
    if (player) this.players.set(playerId, { ...player, status });
  }
}

class MemoryPlayerIdentityRepository implements PlayerIdentityRepository {
  identities = new Map<string, Player>();

  async save(): Promise<void> {
    throw new Error("player auth test does not save identities");
  }

  async delete(): Promise<void> {
    throw new Error("player auth test does not delete identities");
  }

  async findPlayerByIdentity(provider: string, subject: string): Promise<Player | null> {
    return this.identities.get(`${provider}:${subject}`) ?? null;
  }

  async listByPlayerId(): Promise<never[]> {
    return [];
  }
}

class MemoryPlayerSessionRepository implements PlayerSessionRepository {
  sessions = new Map<string, PlayerSession>();

  async save(session: PlayerSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async findByTokenHash(tokenHash: string): Promise<PlayerSession | null> {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, revokedAt });
  }
}

describe("createPlayerAuthService", () => {
  it("logs in an existing player identity and creates a player session", async () => {
    const players = new MemoryPlayerRepository();
    const playerIdentities = new MemoryPlayerIdentityRepository();
    const playerSessions = new MemoryPlayerSessionRepository();
    const player: Player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-08T10:00:00.000Z"),
    };
    await players.save(player);
    playerIdentities.identities.set("qq:123456", player);

    const service = createPlayerAuthService({
      players,
      playerIdentities,
      playerSessions,
      id: () => "player-session-1",
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      createSecret: () => ({
        token: "prism_player_plain",
        tokenHash: "player-session-hash",
        tokenPrefix: "prism_player",
      }),
      sessionDurationMs: 86_400_000,
    });

    const result = await service.loginByIdentity({
      identity: {
        provider: " QQ ",
        subject: "123456",
      },
    });

    expect(result).toEqual({
      token: "prism_player_plain",
      player,
    });
    expect([...playerSessions.sessions.values()]).toEqual([
      {
        id: "player-session-1",
        playerId: "player-1",
        tokenHash: "player-session-hash",
        expiresAt: new Date("2026-07-09T12:00:00.000Z"),
        createdAt: new Date("2026-07-08T12:00:00.000Z"),
        lastUsedAt: new Date("2026-07-08T12:00:00.000Z"),
        revokedAt: null,
      },
    ]);
  });

  it("authenticates active player sessions and rejects expired or revoked sessions", async () => {
    const players = new MemoryPlayerRepository();
    const playerSessions = new MemoryPlayerSessionRepository();
    await players.save({
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-08T10:00:00.000Z"),
    });
    await playerSessions.save({
      id: "session-active",
      playerId: "player-1",
      tokenHash: "active-hash",
      expiresAt: new Date("2026-07-08T13:00:00.000Z"),
      createdAt: new Date("2026-07-08T10:00:00.000Z"),
      lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
      revokedAt: null,
    });
    await playerSessions.save({
      id: "session-expired",
      playerId: "player-1",
      tokenHash: "expired-hash",
      expiresAt: new Date("2026-07-08T11:00:00.000Z"),
      createdAt: new Date("2026-07-08T10:00:00.000Z"),
      lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
      revokedAt: null,
    });
    await playerSessions.save({
      id: "session-revoked",
      playerId: "player-1",
      tokenHash: "revoked-hash",
      expiresAt: new Date("2026-07-08T13:00:00.000Z"),
      createdAt: new Date("2026-07-08T10:00:00.000Z"),
      lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
      revokedAt: new Date("2026-07-08T11:30:00.000Z"),
    });

    const service = createPlayerAuthService({
      players,
      playerIdentities: new MemoryPlayerIdentityRepository(),
      playerSessions,
      id: () => "unused",
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      createSecret: () => ({
        token: "unused",
        tokenHash: "unused",
        tokenPrefix: "prism_player",
      }),
      sessionDurationMs: 86_400_000,
    });

    await expect(service.authenticate("active-hash")).resolves.toEqual({
      playerId: "player-1",
    });
    await expect(service.authenticate("expired-hash")).resolves.toBeNull();
    await expect(service.authenticate("revoked-hash")).resolves.toBeNull();
  });
});
