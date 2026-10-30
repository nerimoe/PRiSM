import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migrations = resolve(import.meta.dir, "../../../migrations");
const names = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const migration = "0043_legacy_bot_resources.sql";
const now = "2026-10-30T15:00:00.000Z";
const run = (db: Database, name: string) => {
  for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) db.run(sql);
};

function fixture() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=OFF");
  for (const name of names.filter((name) => name < migration)) run(db, name);
  db.run("PRAGMA foreign_keys=ON");
  db.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u','user',?,?)", [now, now]);
  const token = (shop: string, id: string, status = "active", role = "integration") => {
    db.run("INSERT OR IGNORE INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,0,0,80,'u')", [shop, shop, shop]);
    db.run("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [shop, id, shop, role, "prefix", `hash-${id}`, status, now]);
  };
  const bots = () => db.query<{ shop: string; id: string; token: string; name: string; public_id: string }, []>(
    `SELECT m.shop_id AS shop,m.id,json_extract(c.config_json,'$.tokenId') AS token,m.name,m.public_id
     FROM machines m JOIN device_capabilities c ON c.shop_id=m.shop_id AND c.device_id=m.id
     WHERE c.capability='bot' ORDER BY m.shop_id,m.id`,
  ).all();
  return { db, token, bots };
}

describe("migration 0043: legacy Bot resources", () => {
  for (const existingResource of [false, true]) it(`keeps equal token ids and ambiguous concatenations separate, existing resource=${existingResource}`, () => {
    const { db, token, bots } = fixture();
    try {
      for (const [shop, id] of [["a", "shared"], ["b", "shared"], ["a-b", "c"], ["a", "b-c"]] as const) token(shop, id);
      // An old resource id must not block another shop's migration or be repurposed.
      if (existingResource) db.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('bot-shared','existing','a','已有资源','')");
      run(db, migration);
      const before = bots();
      expect(before.map(({ shop, token }) => ({ shop, token }))).toEqual(expect.arrayContaining([
        { shop: "a", token: "shared" }, { shop: "b", token: "shared" },
        { shop: "a-b", token: "c" }, { shop: "a", token: "b-c" },
      ]));
      expect(before).toHaveLength(4);
      expect(new Set(before.map((bot) => bot.id)).size).toBe(4);
      if (existingResource) expect(db.query("SELECT name FROM machines WHERE id='bot-shared'").get()).toEqual({ name: "已有资源" });
      expect(db.query("SELECT COUNT(*) AS n FROM api_tokens WHERE status='active'").get()).toEqual({ n: 4 });
      run(db, migration);
      expect(bots()).toEqual(before);
      for (const name of names.filter((name) => name > migration)) run(db, name);
      expect(bots()).toEqual(before);
    } finally { db.close(); }
  });

  it("can finish after resource insertion without recreating the resource or its public id", () => {
    const { db, token, bots } = fixture();
    try {
      token("shop", "old");
      const first = splitD1MigrationStatements(readFileSync(resolve(migrations, migration), "utf8"))[0]!;
      db.run(first);
      const resource = db.query("SELECT id,public_id,name FROM machines").get();
      run(db, migration);
      expect(bots()).toHaveLength(1);
      expect(db.query("SELECT id,public_id,name FROM machines").get()).toEqual(resource);
      expect(db.query("SELECT COUNT(*) AS n FROM machines").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it("preserves existing Bot resources and skips revoked and machine credentials", () => {
    const { db, token, bots } = fixture();
    try {
      token("shop", "old");
      token("shop", "revoked", "revoked");
      token("shop", "machine", "active", "machine");
      db.run("INSERT INTO machines(id,public_id,shop_id,name,enabled,hinata_url_encrypted) VALUES ('old-resource','old-public','shop','原 Bot',0,'')");
      db.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
        VALUES ('shop','old-resource','bot',?,'{}',?,?)`, [JSON.stringify({ tokenId: "old", announcePower: true }), now, now]);
      run(db, migration);
      expect(bots()).toEqual([{ shop: "shop", id: "old-resource", token: "old", name: "原 Bot", public_id: "old-public" }]);
      expect(db.query("SELECT enabled FROM machines WHERE id='old-resource'").get()).toEqual({ enabled: 0 });
      expect(JSON.parse((db.query("SELECT config_json FROM device_capabilities WHERE device_id='old-resource'").get() as { config_json: string }).config_json)).toEqual({ tokenId: "old", announcePower: true });
      expect(db.query("SELECT COUNT(*) AS n FROM api_tokens").get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });
});
