import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256 } from "../src/crypto.js";
import type { Env } from "../src/bindings.js";

const migrationDir=resolve(import.meta.dir,"../../../migrations");

async function transferFixture() {
  const sqlite=new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for(const filename of readdirSync(migrationDir).filter(name=>name.endsWith(".sql")).sort()) {
    for(const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir,filename),"utf8"))) {
      sqlite.run(statement);
    }
  }
  sqlite.run("PRAGMA foreign_keys=ON");
  const now=new Date().toISOString();
  const userId="transfer-owner";
  const token="transfer-owner-session";
  sqlite.run(
    "INSERT INTO users(id,role,created_at,updated_at) VALUES (?, 'user',?,?)",
    [userId,now,now],
  );
  sqlite.run(
    "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('transfer-session',?,?,?)",
    [userId,await sha256(token),new Date(Date.now()+86_400_000).toISOString()],
  );
  for(const id of ["source","destination"]) {
    sqlite.run(
      "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,31.23,121.47,80,?)",
      [id,id,id,userId],
    );
    sqlite.run(
      "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      [`member-${id}`,id,userId],
    );
  }
  sqlite.run(
    "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('source','venue.operations',?,?)",
    [JSON.stringify({timeZone:"UTC",coinCooldownMs:42_000}),now],
  );
  const d1=createD1DatabaseFromSqlite(sqlite);
  const limiter={limit:async()=>({success:true})};
  const env={DB:d1,SESSION_SECRET:"transfer-secret",RATE_LIMIT_10:limiter} as unknown as Env;
  return {sqlite,env,app:createApp(),headers:{authorization:`Bearer ${token}`}};
}

describe("pre-fork shop data restore on migrated D1 schema",()=>{
  it("exports a real v1 configuration backup and imports it into an empty shop",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const url="https://prism.test/api/v1/shops";
    const exported=await app.fetch(new Request(`${url}/source/data/export?version=1&scope=configuration`,{headers}),env);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment;");
    const backup=await exported.json() as Record<string,unknown>;
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.version).toBe(1);
    expect(backup.scope).toBe("configuration");
    const previewed=await app.fetch(new Request(`${url}/destination/data/import/preview`,{
      method:"POST",
      headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({backup}),
    }),env);
    expect(previewed.status).toBe(200);
    const preview=(await previewed.json() as {data:{canImport:boolean;fingerprint:string}}).data;
    expect(preview.canImport).toBe(true);
    const applied=await app.fetch(new Request(`${url}/destination/data/import/apply`,{
      method:"POST",
      headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({backup,fingerprint:preview.fingerprint,operationId:crypto.randomUUID()}),
    }),env);
    expect(applied.status).toBe(200);
    const settings=sqlite.query(
      "SELECT value_json FROM app_settings WHERE shop_id='destination' AND key='venue.operations'",
    ).get() as {value_json:string}|null;
    expect(JSON.parse(settings?.value_json??"{}").coinCooldownMs).toBe(42_000);
    sqlite.close();
  });
});
