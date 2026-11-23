import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("checkout backfill is repeatable, tenant scoped and preserves existing archived bills", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE sessions(shop_id TEXT, id TEXT, player_id TEXT);
      CREATE TABLE settlements(shop_id TEXT,id TEXT,session_id TEXT,checkout_id TEXT,subtotal INTEGER,total INTEGER,status TEXT,settled_at TEXT);
      CREATE TABLE player_checkouts(shop_id TEXT,id TEXT,player_id TEXT,subtotal INTEGER,total INTEGER,status TEXT,settled_at TEXT,PRIMARY KEY(shop_id,id));
      CREATE TABLE checkout_report_states(shop_id TEXT,checkout_id TEXT,archived INTEGER);
      INSERT INTO sessions VALUES ('a','s','p'),('b','s','other');
      INSERT INTO settlements VALUES
        ('a','legacy','s',NULL,100,90,'settled','2026-08-01T12:00:00Z'),
        ('b','legacy','s',NULL,200,180,'settled','2026-08-01T12:00:00Z'),
        ('a','normal','s','existing',300,250,'settled','2026-08-02T12:00:00Z');
      INSERT INTO player_checkouts VALUES ('a','existing','p',300,250,'settled','2026-08-02T12:00:00Z');
      INSERT INTO checkout_report_states VALUES ('a','existing',1);
    `);
    const sql = readFileSync(new URL("../../../migrations/0058_legacy_settlement_checkouts.sql", import.meta.url), "utf8");
    db.exec(sql);
    db.exec(sql);
    expect(db.query("SELECT shop_id,player_id,total FROM player_checkouts ORDER BY shop_id,id").all()).toEqual([
      { shop_id: "a", player_id: "p", total: 250 },
      { shop_id: "a", player_id: "p", total: 90 },
      { shop_id: "b", player_id: "other", total: 180 },
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM settlements WHERE checkout_id IS NULL").get()).toEqual({ n: 0 });
    expect(db.query("SELECT * FROM checkout_report_states").all()).toEqual([{ shop_id: "a", checkout_id: "existing", archived: 1 }]);
  } finally {
    db.close();
  }
});
