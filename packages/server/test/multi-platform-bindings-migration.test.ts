import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { initializeLocalDatabase } from "../src/local-server.js";

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const migration0062 = resolve(migrationDir, "0062_multi_platform_bindings.sql");

describe("migration 0062: allow multiple bindings per user and provider", () => {
  it("drops UNIQUE(shop_id, user_id, provider), preserves rows, and recreates all triggers", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=OFF");
    for (const filename of readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql") && name < "0062_")
      .sort()) {
      for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir, filename), "utf8"))) {
        sqlite.run(statement);
      }
    }
    sqlite.run("PRAGMA foreign_keys=ON");

    const now = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1', 'user', ?, ?), ('u2', 'user', ?, ?)", [now, now, now, now]);
    sqlite.run(
      "INSERT INTO shops(id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('s1', 's1', 'Shop 1', 31.23, 121.47, 80, 'u1')",
    );
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1', 'p1', 'Alice', 'active', ?), ('s1', 'p2', 'Bob', 'active', ?)", [now, now]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id, user_id, player_id, verified_at) VALUES ('s1', 'u1', 'p1', ?), ('s1', 'u2', 'p2', ?)", [now, now]);
    sqlite.run(
      "INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1', 'p1', 'onebot', '10001', ?), ('s1', 'p1', 'onebot', '10002', ?), ('s1', 'p2', 'onebot', '20001', ?)",
      [now, now, now],
    );
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u1', 'onebot', '10001', ?)", [now]);
    sqlite.run(
      "INSERT INTO shop_data_jobs(id, shop_id, user_id, kind, status, header_json, target_state, fingerprint, result_json, operation_id, created_at, expires_at) VALUES ('job-ready', 's1', 'u1', 'import', 'ready', '{}', NULL, NULL, NULL, NULL, ?, ?)",
      [now, future],
    );

    // Before 0062, binding a second onebot subject to u1 is rejected.
    expect(() =>
      sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u1', 'onebot', '10002', ?)", [now]),
    ).toThrow(/UNIQUE/);

    for (const sql of splitD1MigrationStatements(readFileSync(migration0062, "utf8"))) {
      sqlite.run(sql);
    }

    // Existing row stays, and u1 can bind a second onebot account.
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u1', 'onebot', '10002', ?)", [now]);
    expect(
      sqlite
        .query("SELECT subject FROM shop_platform_bindings WHERE shop_id = 's1' AND user_id = 'u1' AND provider = 'onebot' ORDER BY subject")
        .all(),
    ).toEqual([{ subject: "10001" }, { subject: "10002" }]);

    // Another user claiming the same (provider, subject) is still rejected by the primary key / owner trigger.
    expect(() =>
      sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u2', 'onebot', '10001', ?)", [now]),
    ).toThrow(/platform binding identity belongs to another player|UNIQUE|PRIMARY KEY/);

    // Binding an identity owned by a different player is still blocked by platform_binding_owner_insert.
    expect(() =>
      sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u2', 'onebot', '10002', ?)", [now]),
    ).toThrow(/platform binding identity belongs to another player/);

    const triggers = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'shop_platform_bindings' ORDER BY name")
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toEqual([
      "platform_binding_owner_insert",
      "platform_binding_owner_update",
      "shop_export_shop_platform_bindings_delete",
      "shop_export_shop_platform_bindings_insert",
      "shop_export_shop_platform_bindings_update",
      "shop_import_target_shop_platform_bindings_delete",
      "shop_import_target_shop_platform_bindings_insert",
      "shop_import_target_shop_platform_bindings_update",
    ]);
    expect(
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shop_platform_bindings_user'").get(),
    ).not.toBeNull();

    // Import target trigger still marks ready import jobs stale.
    expect(sqlite.query("SELECT status FROM shop_data_jobs WHERE id = 'job-ready'").get()).toEqual({ status: "stale" });

    // Export lock trigger still blocks mutations during an active export.
    sqlite.run(
      "INSERT INTO shop_data_exports(id, shop_id, user_id, scope, month, status, created_at, expires_at) VALUES ('exp1', 's1', 'u1', 'business', '2026-01', 'active', ?, ?)",
      [now, future],
    );
    expect(() =>
      sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u2', 'onebot', '20001', ?)", [now]),
    ).toThrow(/SHOP_EXPORT_LOCKED/);

    sqlite.close();
  });

  it("rebuilds legacy UNIQUE(shop_id, user_id, provider) on local SQLite initialization", () => {
    const sqlite = new Database(":memory:");
    const now = "2026-01-01T00:00:00.000Z";
    sqlite.run(`CREATE TABLE shop_platform_bindings (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, provider, subject),
      UNIQUE(shop_id, user_id, provider)
    )`);
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u1', 'onebot', '10001', ?)", [now]);

    initializeLocalDatabase(sqlite);

    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1', 'u1', 'onebot', '10002', ?)", [now]);
    expect(
      sqlite
        .query("SELECT subject FROM shop_platform_bindings WHERE shop_id = 's1' AND user_id = 'u1' AND provider = 'onebot' ORDER BY subject")
        .all(),
    ).toEqual([{ subject: "10001" }, { subject: "10002" }]);
    sqlite.close();
  });
});
