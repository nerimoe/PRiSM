import { describe, expect, it } from "bun:test";
import type { PrismAppDependencies } from "@prism/server-hono";
import { createPrismLocalFetchHandler } from "../src/local-server";

describe("createPrismLocalFetchHandler", () => {
  it("calls Bun websocket upgrade as a server method", async () => {
    const fetch = createPrismLocalFetchHandler(dependenciesWithMachineToken());
    let upgraded = false;
    const server = {
      upgrade(this: unknown, request: Request, options: { data: Record<string, unknown> }) {
        expect(this).toBe(server);
        expect(request.url).toBe("https://prism.example.com/rpc/machine/ws");
        expect(options).toEqual({ data: {} });
        upgraded = true;
        return true;
      },
    };

    const response = await fetch(
      new Request("https://prism.example.com/rpc/machine/ws", {
        headers: {
          Authorization: "Bearer machine-token",
        },
      }),
      server,
    );

    expect(response).toBeUndefined();
    expect(upgraded).toBe(true);
  });

});

function dependenciesWithMachineToken(): PrismAppDependencies {
  return {
    playerCommands: unreachablePlayerCommands(),
    playerCheckoutCommands: unreachableCheckoutCommands(),
    playerRedeemCommands: unreachableRedeemCommands(),
    playerQueries: unreachablePlayerQueries(),
    staffQueries: unreachableStaffQueries(),
    staffOperations: {} as PrismAppDependencies["staffOperations"],
    apiTokenAuth: {
      async authenticateApiToken(token) {
        return token === "machine-token" ? { role: "machine" } : null;
      },
    },
    machineConnectionCommands: {
      async hello() {},
      async heartbeat() {},
      async disconnect() {},
      async listDeliverableCommands() {
        return [];
      },
      async ack() {
        throw new Error("ack should not run during upgrade");
      },
    },
  };
}

function unreachablePlayerCommands(): PrismAppDependencies["playerCommands"] {
  return {
    async startSession() {
      throw new Error("player command should not run during upgrade");
    },
    async requestDeviceCommand() {
      throw new Error("player command should not run during upgrade");
    },
  };
}

function unreachableCheckoutCommands(): PrismAppDependencies["playerCheckoutCommands"] {
  return {
    async previewCheckout() {
      throw new Error("checkout should not run during upgrade");
    },
    async checkout() {
      throw new Error("checkout should not run during upgrade");
    },
  };
}

function unreachableRedeemCommands(): PrismAppDependencies["playerRedeemCommands"] {
  return {
    async redeemCode() {
      throw new Error("redeem should not run during upgrade");
    },
  };
}

function unreachablePlayerQueries(): PrismAppDependencies["playerQueries"] {
  return {
    async getPlayerSummary() {
      throw new Error("player query should not run during upgrade");
    },
  };
}

function unreachableStaffQueries(): PrismAppDependencies["staffQueries"] {
  return {
    async listPlayers() {
      throw new Error("staff query should not run during upgrade");
    },
    async listActiveSessions() {
      throw new Error("staff query should not run during upgrade");
    },
  };
}
