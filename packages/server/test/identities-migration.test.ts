import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { initializeLocalDatabase } from "../src/local-server.js";

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const NOW = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function run(sqlite: Database, file: string) {
  for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir, file), "utf8"))) sqlite.run(statement);
}

function migrateBefore(sqlite: Database, prefix: string) {
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql") && name < prefix).sort()) run(sqlite, file);
  sqlite.run("PRAGMA foreign_keys=ON");
}

const identities = (sqlite: Database, shop = "s1") =>
  sqlite
    .query("SELECT player_id, provider, subject FROM player_identities WHERE shop_id = ? ORDER BY player_id, provider, subject")
    .all(shop);

const freeze = (sqlite: Database, id: string) =>
  sqlite.run(
    "INSERT INTO shop_data_exports(id, shop_id, scope, month, status, created_at, expires_at) VALUES (?, 's1', 'business', '2026-01', 'active', ?, ?)",
    [id, NOW, FUTURE],
  );

describe("migration 0063: every profile identity lives in player_identities", () => {
  it("moves account links and verified bindings into identities and drops both tables", () => {
    const sqlite = new Database(":memory:");
    migrateBefore(sqlite, "0063_");

    sqlite.run(
      "INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1','user',?,?), ('u2','user',?,?), ('u3','user',?,?), ('u4','user',?,?)",
      [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW],
    );
    sqlite.run("INSERT INTO shops(id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('s1','s1','Shop',31.23,121.47,80,'u1')");
    sqlite.run(
      "INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1','p1','Alice','active',?), ('s1','p2','Bob','active',?), ('s1','p3','Desk','active',?), ('s1','p4','Eve','active',?)",
      [NOW, NOW, NOW, NOW],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts(shop_id, user_id, player_id, verified_at) VALUES ('s1','u1','p1',?), ('s1','u2','p2',?), ('s1','u3','p3',?), ('s1','u4','p4',?)",
      [NOW, NOW, NOW, NOW],
    );
    sqlite.run(
      "INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1','p1','onebot','10001',?), ('s1','p2','onebot','20001',?)",
      [NOW, NOW],
    );
    // u1 already has its identity; a stale one puts u9 on p2 (the table says u2);
    // u4's identity sits on the wrong profile.
    sqlite.run(
      "INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1','p1','web-account','u1',?), ('s1','p2','web-account','u9',?), ('s1','p1','web-account','u4',?)",
      [NOW, NOW, NOW],
    );
    sqlite.run(
      "INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1','u1','onebot','10001',?), ('s1','u2','onebot','20001',?)",
      [NOW, NOW],
    );
    // A binding whose identity row went missing, and one on a cashier profile that may hold no identity.
    sqlite.run("PRAGMA foreign_keys=OFF");
    sqlite.run("DROP TRIGGER IF EXISTS platform_binding_owner_insert");
    sqlite.run(
      "INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1','u2','onebot','20002',?), ('s1','u3','onebot','30001',?)",
      [NOW, NOW],
    );
    sqlite.run("INSERT INTO cashier_profiles(shop_id, player_id, card_kind, card_uid, created_at) VALUES ('s1','p3','type-a','CARD1',?)", [NOW]);
    sqlite.run("PRAGMA foreign_keys=ON");
    // The shop is frozen for export: the migration still moves its rows.
    freeze(sqlite, "e1");

    run(sqlite, "0063_identities_in_player_identities.sql");

    expect(
      sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('shop_player_accounts','shop_platform_bindings')").all(),
    ).toEqual([]);
    expect(identities(sqlite)).toEqual([
      { player_id: "p1", provider: "onebot", subject: "10001" },
      { player_id: "p1", provider: "web-account", subject: "u1" },
      { player_id: "p2", provider: "onebot", subject: "20001" },
      { player_id: "p2", provider: "onebot", subject: "20002" },
      { player_id: "p2", provider: "web-account", subject: "u2" },
      { player_id: "p4", provider: "web-account", subject: "u4" },
    ]);
    // The export lock is back in force, for identities and for the accounts' login identities.
    expect(() =>
      sqlite.run("INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1','p4','qq','1',?)", [NOW]),
    ).toThrow(/SHOP_EXPORT_LOCKED/);
    expect(() =>
      sqlite.run("INSERT INTO auth_identities(id, user_id, provider, provider_subject) VALUES ('a1','u1','munet','m1')"),
    ).toThrow(/SHOP_EXPORT_LOCKED/);
    sqlite.run("UPDATE shop_data_exports SET status='completed'");
    // A profile holds one account.
    expect(() =>
      sqlite.run("INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1','p1','web-account','u5',?)", [NOW]),
    ).toThrow(/UNIQUE/);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_binding_codes'").get()).toBeTruthy();
    sqlite.close();
  });

  it("moves leftover tables on local SQLite initialization", () => {
    const sqlite = new Database(":memory:");
    initializeLocalDatabase(sqlite);
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1','user',?,?)", [NOW, NOW]);
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('default','p1','Alice','active',?)", [NOW]);
    sqlite.run("CREATE TABLE shop_player_accounts (shop_id TEXT, user_id TEXT, player_id TEXT, verified_at TEXT, PRIMARY KEY(shop_id, user_id))");
    sqlite.run("INSERT INTO shop_player_accounts VALUES ('default','u1','p1',?)", [NOW]);
    sqlite.run(
      "CREATE TABLE shop_platform_bindings (shop_id TEXT, user_id TEXT, provider TEXT, subject TEXT, verified_at TEXT, PRIMARY KEY(shop_id, provider, subject))",
    );
    sqlite.run("INSERT INTO shop_platform_bindings VALUES ('default','u1','onebot','10001',?)", [NOW]);

    initializeLocalDatabase(sqlite);

    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('shop_player_accounts','shop_platform_bindings')").all()).toEqual([]);
    expect(identities(sqlite, "default")).toEqual([
      { player_id: "p1", provider: "onebot", subject: "10001" },
      { player_id: "p1", provider: "web-account", subject: "u1" },
    ]);
    sqlite.close();
  });
});
