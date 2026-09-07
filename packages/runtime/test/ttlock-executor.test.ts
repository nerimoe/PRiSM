import { describe, expect, it } from "bun:test";
import { createTTLockExecutor, resolveTTLockDeviceRef, TTLockClient } from "../src/ttlock-executor";

const connection = {
  baseUrl: "https://api.sciener.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  appAccount: "15517998347",
  appPwd: "password",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: null,
};

const device = {
  id: "front-door",
  name: "前门",
  aliases: ["door", "门禁"],
  lockId: 25356943,
};

describe("TTLock executor", () => {
  it("resolves configured names and aliases", () => {
    expect(resolveTTLockDeviceRef("门禁", [device])).toEqual(device);
    expect(resolveTTLockDeviceRef("DOOR", [device])).toEqual(device);
    expect(resolveTTLockDeviceRef("25356943", [device])).toBeNull();
  });

  it("unlocks a configured lock through the cloud API", async () => {
    const requests: Request[] = [];
    const executor = createTTLockExecutor({
      connection,
      devices: [device],
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json({ errcode: 0, errmsg: "none error message" });
      },
    });

    const result = await executor.execute({
      command: {
        id: "command-1",
        type: "door.open",
        deviceId: "front-door",
        targetKind: "facility",
        executorKind: "ttlock",
        status: "pending",
        requestedAt: new Date("2026-09-07T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ status: "success" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.sciener.com/v3/lock/unlock");
    const body = await requests[0].text();
    expect(body).toContain("clientId=client-id");
    expect(body).toContain("accessToken=access-token");
    expect(body).toContain("lockId=25356943");
  });

  it("refreshes an expired token and persists the replacement", async () => {
    const requests: Request[] = [];
    let updatedConnection: Record<string, unknown> | undefined;
    const client = new TTLockClient({
      connection,
      fetcher: async (url, init) => {
        const request = new Request(url, init);
        requests.push(request);
        if (request.url.endsWith("/oauth2/token")) {
          return Response.json({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7776000,
          });
        }
        if (request.url.endsWith("/v3/lock/unlock")) {
          const body = await request.text();
          return body.includes("accessToken=new-access-token")
            ? Response.json({ errcode: 0 })
            : Response.json({ errcode: 10004, errmsg: "invalid grant" });
        }
        return Response.json({ errcode: 10004, errmsg: "invalid grant" });
      },
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      onConnectionUpdated: (next) => {
        updatedConnection = next;
      },
    });

    await expect(client.unlock(device.lockId)).resolves.toEqual({ errcode: 0 });
    expect(requests).toHaveLength(3);
    expect(requests[1].url).toBe("https://api.sciener.com/oauth2/token");
    const refreshBody = await requests[1].text();
    expect(refreshBody).toContain("grant_type=refresh_token");
    expect(refreshBody).toContain("refresh_token=refresh-token");
    expect(updatedConnection).toBeDefined();
    expect(updatedConnection?.accessToken).toBe("new-access-token");
    expect(updatedConnection?.refreshToken).toBe("new-refresh-token");
  });

  it("maps an open-state response to a successful executor call", async () => {
    const client = new TTLockClient({
      connection,
      fetcher: async () => Response.json({ state: 1 }),
    });
    await expect(client.queryOpenState(device.lockId)).resolves.toEqual({ state: 1 });
  });
});
