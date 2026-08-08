import { describe, expect, it } from "bun:test";
import { createHomeAssistantStateSource } from "../src/home-assistant-state-source";

describe("createHomeAssistantStateSource", () => {
  it("reads one entity state with the configured authorization", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const source = createHomeAssistantStateSource({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ state: "on" });
      },
    });

    await expect(source.readState({
      connection: { url: "https://ha.example.com/", token: "ha-token" },
      device: { name: "舞萌一号", id: "switch.maimai_1" },
    })).resolves.toBe("on");
    expect(calls).toEqual([{
      url: "https://ha.example.com/api/states/switch.maimai_1",
      init: expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer ha-token",
          "Content-Type": "application/json",
        },
      }),
    }]);
  });

  it("invokes the runtime fetch as a plain function", async () => {
    let receivedThis: unknown = globalThis;
    const source = createHomeAssistantStateSource({
      fetch: async function (this: unknown) {
        receivedThis = this;
        return Response.json({ state: "off" });
      },
    });

    await source.readState({
      connection: { url: "https://ha.example.com", token: "ha-token" },
      device: { name: "WACCA", id: "light.wacca" },
    });
    expect(receivedThis).toBeUndefined();
  });

  it("rejects non-successful Home Assistant responses", async () => {
    const source = createHomeAssistantStateSource({
      fetch: async () => new Response("offline", { status: 503 }),
    });

    await expect(source.readState({
      connection: { url: "https://ha.example.com", token: "ha-token" },
      device: { name: "WACCA", id: "light.wacca" },
    })).rejects.toThrow("Home Assistant state request failed with 503");
  });
});
