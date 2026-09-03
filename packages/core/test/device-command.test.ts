import { describe, expect, it } from "bun:test";
import { ackDeviceCommand, expireDeviceCommand, PrismDomainError, requestDeviceCommand } from "../src/index";

describe("requestDeviceCommand", () => {
  it("creates a pending coin command for an active player session", () => {
    const result = requestDeviceCommand({
      actor: {
        type: "player",
        playerId: "player-1",
      },
      command: {
        type: "coin",
        target: {
          kind: "game_machine",
          id: "machine-1",
        },
        payload: {
          count: 1,
        },
      },
      activeSessions: [
        {
          id: "session-1",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          status: "active",
        },
      ],
      previousCommands: [],
      now: new Date("2026-06-07T10:05:00.000Z"),
      id: "command-1",
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
  });

  it("routes resolved Hinata IO targets to the direct executor", () => {
    const result = requestDeviceCommand({
      actor: { type: "staff", staffId: "staff-1" },
      command: {
        type: "coin",
        target: {
          kind: "game_machine",
          id: "maimai-1",
          executorKind: "hinata_io",
        },
        payload: { count: 1 },
      },
      activeSessions: [],
      previousCommands: [],
      now: new Date("2026-08-15T00:00:00.000Z"),
      id: "command-hinata",
    });

    expect(result).toMatchObject({
      deviceId: "maimai-1",
      executorKind: "hinata_io",
      status: "pending",
    });
  });

  it("rejects player coin and power commands without an active session", () => {
    for (const command of [
      {
        type: "coin",
        target: { kind: "game_machine", id: "machine-1" },
        payload: { count: 1 },
      },
      {
        type: "power.on",
        target: { kind: "facility", id: "switch.machine-1" },
      },
      {
        type: "power.off",
        target: { kind: "facility", id: "switch.machine-1" },
      },
    ] as const) {
      expect(() =>
        requestDeviceCommand({
          actor: {
            type: "player",
            playerId: "player-1",
          },
          command,
          activeSessions: [],
          previousCommands: [],
          now: new Date("2026-06-07T10:05:00.000Z"),
          id: "command-1",
        }),
      ).toThrow(
        expect.objectContaining({
          name: "PrismDomainError",
          code: "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
        }) as PrismDomainError,
      );
    }
  });

  it("rejects coin commands within the player cooldown window", () => {
    expect(() =>
      requestDeviceCommand({
        actor: {
          type: "player",
          playerId: "player-1",
        },
        command: {
          type: "coin",
          target: {
            kind: "game_machine",
            id: "machine-2",
          },
          payload: {
            count: 1,
          },
        },
        activeSessions: [
          {
            id: "session-1",
            playerId: "player-1",
            startedAt: new Date("2026-06-07T10:00:00.000Z"),
            status: "active",
          },
        ],
        previousCommands: [
          {
            id: "command-0",
            type: "coin",
            deviceId: "machine-1",
            targetKind: "game_machine",
            executorKind: "machine_ws",
            playerId: "player-1",
            status: "acked",
            payload: {
              count: 1,
            },
            requestedAt: new Date("2026-06-07T10:04:30.000Z"),
          },
        ],
        coinCooldownMs: 60_000,
        now: new Date("2026-06-07T10:05:00.000Z"),
        id: "command-1",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "COIN_COMMAND_COOLDOWN_ACTIVE",
      }) as PrismDomainError,
    );
  });

  it("allows staff to create device commands without an active player session", () => {
    const result = requestDeviceCommand({
      actor: {
        type: "staff",
        staffId: "staff-1",
      },
      command: {
        type: "door.open",
        target: {
          kind: "facility",
          id: "front-door",
        },
      },
      activeSessions: [],
      previousCommands: [],
      now: new Date("2026-06-07T10:05:00.000Z"),
      id: "command-1",
    });

    expect(result).toEqual({
      id: "command-1",
      type: "door.open",
      deviceId: "front-door",
      targetKind: "facility",
      executorKind: "home_assistant",
      staffId: "staff-1",
      status: "pending",
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });
  });

  it("represents an all-facility power command without a device id", () => {
    const result = requestDeviceCommand({
      actor: { type: "staff", staffId: "staff-1" },
      command: {
        type: "power.off",
        target: { kind: "facility", all: true },
      },
      activeSessions: [],
      previousCommands: [],
      now: new Date("2026-06-07T10:05:00.000Z"),
      id: "command-all",
    });

    expect(result.deviceId).toBeNull();
    expect(result.targetKind).toBe("facility");
  });

  it("rejects all-facility targets for non-power actions", () => {
    expect(() =>
      requestDeviceCommand({
        actor: { type: "staff", staffId: "staff-1" },
        command: {
          type: "door.open",
          target: { kind: "facility", all: true },
        },
        activeSessions: [],
        previousCommands: [],
        now: new Date("2026-06-07T10:05:00.000Z"),
        id: "command-all",
      }),
    ).toThrow("All-facility targets only support power actions.");
  });

  it("rejects mismatched targets for action families", () => {
    expect(() =>
      requestDeviceCommand({
        actor: {
          type: "staff",
          staffId: "staff-1",
        },
        command: {
          type: "coin",
          target: {
            kind: "facility",
            id: "script.insert_coin",
          },
        },
        activeSessions: [],
        previousCommands: [],
        now: new Date("2026-06-07T10:05:00.000Z"),
        id: "command-1",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "DEVICE_ACTION_TARGET_MISMATCH",
      }) as PrismDomainError,
    );
  });
});

describe("device command lifecycle", () => {
  it("marks a pending command as acknowledged", () => {
    const result = ackDeviceCommand({
      command: {
        id: "command-1",
        type: "power.on",
        deviceId: "machine-1",
        targetKind: "facility",
        executorKind: "home_assistant",
        playerId: "player-1",
        status: "pending",
        requestedAt: new Date("2026-06-07T10:05:00.000Z"),
      },
      now: new Date("2026-06-07T10:05:03.000Z"),
    });

    expect(result).toEqual({
      id: "command-1",
      type: "power.on",
      deviceId: "machine-1",
      targetKind: "facility",
      executorKind: "home_assistant",
      playerId: "player-1",
      status: "acked",
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
      ackedAt: new Date("2026-06-07T10:05:03.000Z"),
    });
  });

  it("marks a pending command as expired when the agent times out", () => {
    const result = expireDeviceCommand({
      command: {
        id: "command-1",
        type: "coin",
        deviceId: "machine-1",
        targetKind: "game_machine",
        executorKind: "machine_ws",
        playerId: "player-1",
        status: "pending",
        requestedAt: new Date("2026-06-07T10:05:00.000Z"),
      },
      now: new Date("2026-06-07T10:06:00.000Z"),
    });

    expect(result).toEqual({
      id: "command-1",
      type: "coin",
      deviceId: "machine-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "expired",
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
      expiredAt: new Date("2026-06-07T10:06:00.000Z"),
    });
  });

  it("rejects acknowledgements for commands that are no longer pending", () => {
    expect(() =>
      ackDeviceCommand({
        command: {
          id: "command-1",
          type: "coin",
          deviceId: "machine-1",
          targetKind: "game_machine",
          executorKind: "machine_ws",
          playerId: "player-1",
          status: "expired",
          requestedAt: new Date("2026-06-07T10:05:00.000Z"),
          expiredAt: new Date("2026-06-07T10:06:00.000Z"),
        },
        now: new Date("2026-06-07T10:06:05.000Z"),
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "DEVICE_COMMAND_NOT_PENDING",
      }) as PrismDomainError,
    );
  });
});
