import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { initializeLocalDatabase } from "../src/local-server.js";

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const NOW = "2026-01-01T00:00:00.000Z";

function migrateBefore(sqlite: Database, prefix: string) {
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const filename of readdirSync(migrationDir).filter((name) => name.endsWith(".sql") && name < prefix).sort()) {
    for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir, filename), "utf8"))) {
      sqlite.run(statement);
    }
  }
  sqlite.run("PRAGMA foreign_keys=ON");
}

function identities(sqlite: Database) {
  return sqlite
    .query("SELECT player_id, provider, subject FROM player_identities WHERE shop_id = 's1' ORDER BY player_id, provider, subject")
    .all();
}

describe("migration 0063: platform identities live only in player_identities", () => {
  it("keeps every bound identity on the account's profile, then drops shop_platform_bindings", () => {
    const sqlite = new Database(":memory:");
    migrateBefore(sqlite, "0063_");

    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1','user',?,?), ('u2','user',?,?), ('u3','user',?,?)", [NOW, NOW, NOW, NOW, NOW, NOW]);
    sqlite.run("INSERT INTO shops(id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('s1','s1','Shop',31.23,121.47,80,'u1')");
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('s1','p1','Alice','active',?), ('s1','p2','Bob','active',?), ('s1','p3','Desk','active',?)", [NOW, NOW, NOW]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id, user_id, player_id, verified_at) VALUES ('s1','u1','p1',?), ('s1','u2','p2',?), ('s1','u3','p3',?)", [NOW, NOW, NOW]);
    sqlite.run("INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('s1','p1','onebot','10001',?), ('s1','p2','onebot','20001',?)", [NOW, NOW]);
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1','u1','onebot','10001',?), ('s1','u2','onebot','20001',?)", [NOW, NOW]);
    // A binding whose identity row went missing, and one on a cashier profile that may hold no identity.
    sqlite.run("PRAGMA foreign_keys=OFF");
    sqlite.run("DROP TRIGGER IF EXISTS platform_binding_owner_insert");
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('s1','u2','onebot','20002',?), ('s1','u3','onebot','30001',?)", [NOW, NOW]);
    sqlite.run("INSERT INTO cashier_profiles(shop_id, player_id, card_kind, card_uid, created_at) VALUES ('s1','p3','type-a','CARD1',?)", [NOW]);
    sqlite.run("PRAGMA foreign_keys=ON");

    for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir, "0063_drop_platform_bindings.sql"), "utf8"))) {
      sqlite.run(statement);
    }

    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE '%platform_bindings%'").all()).toEqual([]);
    expect(identities(sqlite)).toEqual([
      { player_id: "p1", provider: "onebot", subject: "10001" },
      { player_id: "p2", provider: "onebot", subject: "20001" },
      { player_id: "p2", provider: "onebot", subject: "20002" },
    ]);
    // Binding codes, the proof flow itself, stay.
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_binding_codes'").get()).toBeTruthy();
    sqlite.close();
  });

  it("drops a leftover table on local SQLite initialization, keeping its identities", () => {
    const sqlite = new Database(":memory:");
    initializeLocalDatabase(sqlite);
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1','user',?,?)", [NOW, NOW]);
    sqlite.run("INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('default','p1','Alice','active',?)", [NOW]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id, user_id, player_id, verified_at) VALUES ('default','u1','p1',?)", [NOW]);
    sqlite.run(`CREATE TABLE shop_platform_bindings (
      shop_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(shop_id, provider, subject))`);
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at) VALUES ('default','u1','onebot','10001',?)", [NOW]);

    initializeLocalDatabase(sqlite);

    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'shop_platform_bindings'").get()).toBeNull();
    expect(sqlite.query("SELECT player_id, provider, subject FROM player_identities WHERE shop_id = 'default'").all()).toEqual([
      { player_id: "p1", provider: "onebot", subject: "10001" },
    ]);
    sqlite.close();
  });
});
