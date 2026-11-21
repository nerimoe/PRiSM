import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migration = resolve(import.meta.dir, "../../../migrations/0056_coin_capability.sql");

describe("migration 0056: coin is a capability of its own", () => {
  it("moves each cabinet's coin off its HINATA IO onto a coin that presses one of its keys", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(`CREATE TABLE device_capabilities(
      shop_id TEXT NOT NULL, device_id TEXT NOT NULL, capability TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', secret_json TEXT NOT NULL DEFAULT '{}', credential_hash TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (shop_id, device_id, capability))`);
    const io = (device: string, config: Record<string, unknown>) =>
      sqlite.run("INSERT INTO device_capabilities VALUES ('shop', ?, 'hinata_io', ?, '{\"url\":\"x\"}', NULL, 't', 't')", [device, JSON.stringify(config)]);
    // Only a coin key: it becomes the one key, named 投币, with the limit and auto coin carried over.
    io("plain", { transport: "embedded", channel: "m_1", coinKey: 40, coinAfterSwipe: true, coinCap: 3 });
    // Named keys already, one of them chosen.
    io("named", { transport: "embedded", channel: "m_2", coinKey: 126, coinKeyId: "kc", coinMethod: "key",
      keys: [{ id: "kc", name: "投币", key: 126 }, { id: "ks", name: "服务", key: 125 }], coinCap: null, coinAfterSwipe: false });
    // Named keys, none chosen: no coin, the keys kept.
    io("keysOnly", { transport: "external", coinKey: 0, coinKeyId: null, keys: [{ id: "ks", name: "服务", key: 125 }] });
    // No coin key at all.
    io("none", { transport: "external", coinKey: 0 });
    // Saved before the coin key had a default written: it coined with 32.
    io("bare", { transport: "external" });

    for (const sql of splitD1MigrationStatements(readFileSync(migration, "utf8"))) sqlite.run(sql);
    const config = (device: string, capability: string) => {
      const row = sqlite.query("SELECT config_json FROM device_capabilities WHERE device_id = ? AND capability = ?").get(device, capability) as { config_json: string } | null;
      return row ? JSON.parse(row.config_json) : null;
    };

    expect(config("plain", "hinata_io")).toEqual({ transport: "embedded", channel: "m_1", keys: [{ id: "coin", name: "投币", key: 40 }] });
    expect(config("plain", "coin")).toEqual({ method: "key", keyId: "coin", cap: 3, afterSwipe: true });
    expect(config("named", "hinata_io").keys).toHaveLength(2);
    expect(config("named", "coin")).toEqual({ method: "key", keyId: "kc", cap: null, afterSwipe: false });
    expect(config("keysOnly", "hinata_io")).toEqual({ transport: "external", keys: [{ id: "ks", name: "服务", key: 125 }] });
    expect(config("keysOnly", "coin")).toBeNull();
    expect(config("none", "coin")).toBeNull();
    expect(config("none", "hinata_io")).toEqual({ transport: "external" });
    expect(config("bare", "hinata_io").keys).toEqual([{ id: "coin", name: "投币", key: 32 }]);
    expect(config("bare", "coin")).toMatchObject({ keyId: "coin" });
    // Secrets stay with the IO.
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_capabilities WHERE capability = 'coin' AND secret_json != '{}'").get()).toEqual({ n: 0 });
  });
});
