import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite, initializeLocalDatabase } from "../src/local-server.js";
import { COIN_SETTLE_MS, coinGate } from "../src/resources/capabilities/cabinet.js";
import type { Resource } from "../src/resources/resource.js";

const SHOP = "shop-1";

function cabinet(coinCap: number | null): Resource {
  return {
    id: "m1", shopId: SHOP, publicId: "pub", name: "舞萌", aliases: [], enabled: true, kind: "machine",
    capacity: 1, occupancyMinutes: 15,
    capabilities: new Map([["hinata_io", {
      capability: "hinata_io",
      config: { transport: "embedded", channel: "m_test", coinKey: 32, coinAfterSwipe: false, coinCap },
      secretNames: new Set<string>(),
    } as any]]),
  };
}

function fixture(state: { credit?: number; link?: string } = {}) {
  const sqlite = new Database(":memory:");
  initializeLocalDatabase(sqlite);
  const put = (key: string, value: unknown) => sqlite.run(
    `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
     VALUES (?,?,?,?,?,'observed','2026-01-01T00:00:00.000Z')`,
    [SHOP, "m1", "hinata_io", key, JSON.stringify(value)],
  );
  if (state.link) put("link", state.link);
  if (state.credit !== undefined) put("cabinet", { players: [{ credit: state.credit, remain: 0 }], bookkeeping: {} });
  return createD1DatabaseFromSqlite(sqlite);
}

describe("coin limit from the cabinet's books", () => {
  it("lets a coin in below the limit and holds off the next until the books can show it", async () => {
    const db = fixture({ credit: 0, link: "online" });
    const now = new Date("2026-11-06T00:00:00.000Z");
    expect(await coinGate(db, SHOP, cabinet(2), "a", now)).toBe("ok");
    expect(await coinGate(db, SHOP, cabinet(2), "b", new Date(now.getTime() + 500))).toBe("settling");
    expect(await coinGate(db, SHOP, cabinet(2), "c", new Date(now.getTime() + COIN_SETTLE_MS))).toBe("ok");
  });

  it("refuses a coin once the cabinet holds the limit", async () => {
    expect(await coinGate(fixture({ credit: 2, link: "online" }), SHOP, cabinet(2), "a")).toBe("full");
    expect(await coinGate(fixture({ credit: 5, link: "online" }), SHOP, cabinet(2), "a")).toBe("full");
  });

  it("leaves the decision to the cooldown without a limit or without books it can trust", async () => {
    expect(await coinGate(fixture({ credit: 9, link: "online" }), SHOP, cabinet(null), "a")).toBe("unknown");
    // The IO is not connected: its last books may be stale.
    expect(await coinGate(fixture({ credit: 0, link: "offline" }), SHOP, cabinet(2), "a")).toBe("unknown");
    // An IO that does not read its cabinet.
    expect(await coinGate(fixture({ link: "online" }), SHOP, cabinet(2), "a")).toBe("unknown");
  });
});
