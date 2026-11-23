import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const migration0058 = resolve(migrationDir, "0058_table_capability.sql");

describe("migration 0058: rename mahjong capability and mahjong_seats to table/table_seats", () => {
  it("migrates tables, triggers, indexes, capabilities, events, operations, state, occupancies, and session metadata", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=OFF");
    for (const filename of readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql") && !name.startsWith("0058_"))
      .sort()) {
      for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir, filename), "utf8"))) {
        sqlite.run(statement);
      }
    }
    sqlite.run("PRAGMA foreign_keys=ON");

    const now = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1', 'user', ?, ?)", [now, now]);
    sqlite.run(
      "INSERT INTO shops(id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('s1', 's1', 'Shop 1', 31.23, 121.47, 80, 'u1')",
    );
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1', 'p1', 'Alice', 'active', ?)", [now]);
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1', 'p2', 'Bob', 'active', ?)", [now]);
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1', 'p3', 'Carol', 'active', ?)", [now]);
    sqlite.run(
      "INSERT INTO machines(shop_id, id, public_id, name, hinata_url_encrypted, enabled, created_at, updated_at, kind, aliases_json, capacity) VALUES ('s1', 'm1', 'm1', 'Table 1', '', 1, ?, ?, 'machine', '[]', 4)",
      [now, now],
    );
    sqlite.run(
      "INSERT INTO sessions(shop_id, id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json) VALUES ('s1', 'sess1', 'p1', ?, NULL, 'active', '[]', 'unpaid', NULL, ?)",
      [now, JSON.stringify({ mahjongDeviceId: "m1", extra: 1 })],
    );
    sqlite.run(
      "INSERT INTO sessions(shop_id, id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json) VALUES ('s1', 'sess2', 'p2', ?, NULL, 'active', '[]', 'unpaid', NULL, NULL)",
      [now],
    );
    sqlite.run(
      "INSERT INTO sessions(shop_id, id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json) VALUES ('s1', 'sess3', 'p3', ?, NULL, 'active', '[]', 'unpaid', NULL, NULL)",
      [now],
    );
    sqlite.run(
      "INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, credential_hash, created_at, updated_at) VALUES ('s1', 'm1', 'mahjong', '{\"pricingConfigIds\":[]}', '{}', NULL, ?, ?)",
      [now, now],
    );
    sqlite.run(
      "INSERT INTO mahjong_seats(shop_id, player_id, machine_id, session_id, entry_session_id, joined_at) VALUES ('s1', 'p1', 'm1', 'sess1', NULL, ?)",
      [now],
    );
    sqlite.run(
      "INSERT INTO resource_occupancies(shop_id, id, resource_id, player_id, source, started_at, last_seen_at, expires_at, ended_at, end_reason, session_ids_json) VALUES ('s1', 'occ1', 'm1', 'p1', 'mahjong', ?, ?, NULL, NULL, NULL, '[]')",
      [now, now],
    );
    sqlite.run(
      "INSERT INTO device_operations(shop_id, id, device_id, capability, action, parent_id, player_id, staff_id, status, counts_as_play, failure, payload_json, requested_at, settled_at) VALUES ('s1', 'op1', 'm1', 'mahjong', 'mahjong.seat', NULL, 'p1', NULL, 'succeeded', 0, NULL, '{}', ?, ?)",
      [now, now],
    );
    sqlite.run(
      "INSERT INTO device_events(shop_id, id, device_id, capability, kind, name, operation_id, parent_operation_id, origin, player_id, staff_id, payload_json, occurred_at, via, via_resource_id) VALUES ('s1', 'ev1', 'm1', 'mahjong', 'change', 'mahjong.seat', 'op1', NULL, 'player', 'p1', NULL, '{}', ?, 'page', 'm1')",
      [now],
    );
    sqlite.run(
      "INSERT INTO device_state(shop_id, device_id, capability, key, value_json, authority, event_id, changed_at) VALUES ('s1', 'm1', 'mahjong', 'seats', '[\"p1\"]', 'derived', 'ev1', ?)",
      [now],
    );
    sqlite.run(
      "INSERT INTO shop_data_jobs(id, shop_id, user_id, kind, status, header_json, target_state, fingerprint, result_json, operation_id, created_at, expires_at) VALUES ('job-ready', 's1', 'u1', 'import', 'ready', '{}', NULL, NULL, NULL, NULL, ?, ?)",
      [now, future],
    );

    for (const sql of splitD1MigrationStatements(readFileSync(migration0058, "utf8"))) {
      sqlite.run(sql);
    }

    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mahjong_seats'").get()).toBeNull();
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='table_seats'").get()).not.toBeNull();
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='mahjong_seats_device'").get()).toBeNull();
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='table_seats_device'").get()).not.toBeNull();

    const oldTriggers = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%mahjong_seats%'")
      .all() as { name: string }[];
    expect(oldTriggers).toEqual([]);
    const newTriggers = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%table_seats%' ORDER BY name")
      .all() as { name: string }[];
    expect(newTriggers.map((t) => t.name)).toEqual([
      "shop_export_table_seats_delete",
      "shop_export_table_seats_insert",
      "shop_export_table_seats_update",
      "shop_import_target_table_seats_delete",
      "shop_import_target_table_seats_insert",
      "shop_import_target_table_seats_update",
    ]);

    expect(sqlite.query("SELECT player_id, machine_id, session_id FROM table_seats WHERE shop_id='s1'").get()).toEqual({
      player_id: "p1",
      machine_id: "m1",
      session_id: "sess1",
    });
    expect(sqlite.query("SELECT capability FROM device_capabilities WHERE shop_id='s1' AND device_id='m1'").get()).toEqual({
      capability: "table",
    });
    expect(sqlite.query("SELECT source FROM resource_occupancies WHERE shop_id='s1' AND id='occ1'").get()).toEqual({
      source: "table",
    });
    expect(sqlite.query("SELECT capability, action FROM device_operations WHERE shop_id='s1' AND id='op1'").get()).toEqual({
      capability: "table",
      action: "table.seat",
    });
    expect(sqlite.query("SELECT capability, name FROM device_events WHERE shop_id='s1' AND id='ev1'").get()).toEqual({
      capability: "table",
      name: "table.seat",
    });
    expect(sqlite.query("SELECT capability FROM device_state WHERE shop_id='s1' AND device_id='m1'").get()).toEqual({
      capability: "table",
    });
    const session = sqlite
      .query("SELECT metadata_json FROM sessions WHERE shop_id='s1' AND id='sess1'")
      .get() as { metadata_json: string };
    expect(JSON.parse(session.metadata_json)).toEqual({ tableDeviceId: "m1", extra: 1 });

    // Import target trigger marks ready import jobs stale when table_seats changes.
    sqlite.run(
      "INSERT INTO table_seats(shop_id, player_id, machine_id, session_id, entry_session_id, joined_at) VALUES ('s1', 'p2', 'm1', 'sess2', NULL, ?)",
      [now],
    );
    expect(sqlite.query("SELECT status FROM shop_data_jobs WHERE id='job-ready'").get()).toEqual({ status: "stale" });

    // Active export trigger blocks writes to table_seats with SHOP_EXPORT_LOCKED.
    sqlite.run(
      "INSERT INTO shop_data_exports(id, shop_id, user_id, scope, month, status, created_at, expires_at) VALUES ('exp1', 's1', 'u1', 'business', '2026-01', 'active', ?, ?)",
      [now, future],
    );
    expect(() =>
      sqlite.run(
        "INSERT INTO table_seats(shop_id, player_id, machine_id, session_id, entry_session_id, joined_at) VALUES ('s1', 'p3', 'm1', 'sess3', NULL, ?)",
        [now],
      ),
    ).toThrow(/SHOP_EXPORT_LOCKED/);
    sqlite.close();
  });
});
