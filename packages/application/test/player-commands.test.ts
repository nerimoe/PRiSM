import { describe, expect, it } from "bun:test";
import type {
  DeviceCommand,
  DeviceCommandRepository,
  Player,
  PlayerIdentity,
  PlayerIdentityRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import { createPlayerCommandService } from "../src/index";

class MemorySessionRepository implements SessionRepository {
  saved: Session[] = [];

  constructor(private readonly activeSession: Session | null = null) {}

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    if (this.activeSession?.playerId !== playerId || this.activeSession?.status !== "active") return [];
    return [this.activeSession];
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.saved.find((s) => s.id === sessionId) ?? (this.activeSession?.id === sessionId ? this.activeSession : null);
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter((s) => s.playerId === playerId && s.status === "closed" && s.paymentStatus === "unpaid");
  }

  async save(session: Session): Promise<void> {
    this.saved = this.saved.filter((s) => s.id !== session.id);
    this.saved.push(session);
  }
}

class MemoryDeviceCommandRepository implements DeviceCommandRepository {
  queued: DeviceCommand[] = [];

  constructor(private readonly previousCommands: DeviceCommand[] = []) {}

  async enqueueDeviceCommand(command: DeviceCommand): Promise<void> {
    this.queued.push(command);
  }

  async getDeviceCommand(commandId: string): Promise<DeviceCommand | null> {
    return this.queued.find((command) => command.id === commandId) ?? null;
  }

  async listByPlayerId(playerId: string): Promise<DeviceCommand[]> {
    return this.previousCommands.filter((command) => command.playerId === playerId);
  }

  async listPending(): Promise<DeviceCommand[]> {
    return this.queued.filter((command) => command.status === "pending");
  }
}

class MemoryPlayerIdentityRepository implements PlayerIdentityRepository {
  constructor(private readonly identities: Array<{ identity: PlayerIdentity; player: Player }>) {}

  async save(identity: PlayerIdentity): Promise<void> {
    const player = this.identities.find((entry) => entry.player.id === identity.playerId)?.player;
    if (!player) return;
    this.identities.push({ identity, player });
  }

  async delete(playerId: string, provider: string, subject: string): Promise<void> {
    const index = this.identities.findIndex(
      (entry) =>
        entry.identity.playerId === playerId &&
        entry.identity.provider === provider &&
        entry.identity.subject === subject,
    );
    if (index >= 0) this.identities.splice(index, 1);
  }

  async findPlayerByIdentity(provider: string, subject: string): Promise<Player | null> {
    return (
      this.identities.find((entry) => entry.identity.provider === provider && entry.identity.subject === subject)?.player ??
      null
    );
  }

  async listByPlayerId(playerId: string): Promise<PlayerIdentity[]> {
    return this.identities.filter((entry) => entry.identity.playerId === playerId).map((entry) => entry.identity);
  }
}

describe("createPlayerCommandService", () => {
  it("starts a session through core rules and persists it", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "session-1",
      coinCooldownMs: 60_000,
    });

    const result = await service.startSession({
      playerId: "player-1",
      pricingConfigIds: ["config-1"],
    });

    expect(result).toEqual({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid",
    });
    expect(sessions.saved).toEqual([result]);
  });

  it("rejects starting a session when the current time is outside billable business intervals", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => new Date("2026-06-07T09:00:00.000Z"),
      id: () => "session-closed",
      coinCooldownMs: 60_000,
      canStartSessionAt: async () => false,
    });

    await expect(service.startSession({ playerId: "player-1", pricingConfigIds: ["config-1"] })).rejects.toThrow("Player cannot start a billing session outside billable business intervals.");
    expect(sessions.saved).toEqual([]);
  });

  it("starts a session when the current time matches a billable business interval", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "session-open",
      coinCooldownMs: 60_000,
      canStartSessionAt: async () => true,
    });

    const result = await service.startSession({ playerId: "player-1", pricingConfigIds: ["config-1"] });

    expect(result.id).toBe("session-open");
    expect(sessions.saved).toEqual([result]);
  });

  it("requests a device command through core rules and persists it", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
    };
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      deviceCommands,
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
    });

    const result = await service.requestDeviceCommand({
      playerId: "player-1",
      type: "coin",
      target: {
        kind: "game_machine",
        id: "machine-1",
      },
      payload: {
        count: 1,
      },
    });

    expect(result).toEqual({
      id: "command-1",
      type: "coin",
      deviceId: "machine-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      payload: {
        count: 1,
      },
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });
    expect(deviceCommands.queued).toEqual([result]);
  });

  it("reads the coin cooldown from runtime settings for each coin command", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
    };
    const previousCommands = [
      {
        id: "command-previous",
        type: "coin",
        deviceId: "machine-1",
        targetKind: "game_machine",
        executorKind: "machine_ws",
        playerId: "player-1",
        status: "pending",
        requestedAt: new Date("2026-06-07T10:04:30.000Z"),
      } satisfies DeviceCommand,
    ];
    const deviceCommands = new MemoryDeviceCommandRepository(previousCommands);
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      deviceCommands,
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      getCoinCooldownMs: async () => 20_000,
    });

    const result = await service.requestDeviceCommand({
      playerId: "player-1",
      type: "coin",
      target: {
        kind: "game_machine",
        id: "machine-1",
      },
      payload: {
        count: 1,
      },
    });

    expect(result.id).toBe("command-1");
    expect(deviceCommands.queued).toEqual([result]);
  });

  it("requests a scan command only when the scanned identity belongs to the player", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
    };
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      deviceCommands,
      playerIdentities: new MemoryPlayerIdentityRepository([
        {
          identity: {
            playerId: "player-1",
            provider: "aime",
            subject: "card-1",
            createdAt: new Date("2026-06-07T09:00:00.000Z"),
          },
          player: {
            id: "player-1",
            displayName: "Neri",
            status: "active",
            createdAt: new Date("2026-06-07T09:00:00.000Z"),
          },
        },
      ]),
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
    });

    const result = await service.requestDeviceCommand({
      playerId: "player-1",
      type: "aime.scan",
      target: {
        kind: "game_machine",
        id: "aime-reader-1",
      },
      payload: {
        provider: "aime",
        subject: "card-1",
      },
    });

    expect(result).toEqual({
      id: "command-1",
      type: "aime.scan",
      deviceId: "aime-reader-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      payload: {
        provider: "aime",
        subject: "card-1",
      },
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });
    expect(deviceCommands.queued).toEqual([result]);
  });

  it("rejects scan commands for identities bound to another player", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
    };
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      deviceCommands,
      playerIdentities: new MemoryPlayerIdentityRepository([
        {
          identity: {
            playerId: "player-2",
            provider: "aime",
            subject: "card-2",
            createdAt: new Date("2026-06-07T09:00:00.000Z"),
          },
          player: {
            id: "player-2",
            displayName: "Other",
            status: "active",
            createdAt: new Date("2026-06-07T09:00:00.000Z"),
          },
        },
      ]),
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
    });

    await expect(
      service.requestDeviceCommand({
        playerId: "player-1",
        type: "aime.scan",
        target: {
          kind: "game_machine",
          id: "aime-reader-1",
        },
        payload: {
          provider: "aime",
          subject: "card-2",
        },
      }),
    ).rejects.toMatchObject({
      code: "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER",
    });
    expect(deviceCommands.queued).toEqual([]);
  });

  it("rejects starting a session with a duplicate label for the same player", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
      label: "login",
    };
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "session-2",
      coinCooldownMs: 60_000,
    });

    await expect(
      service.startSession({
        playerId: "player-1",
        pricingConfigIds: ["config-1"],
        label: "login",
      })
    ).rejects.toThrow("Player already has an active session with label 'login'.");
  });
});
