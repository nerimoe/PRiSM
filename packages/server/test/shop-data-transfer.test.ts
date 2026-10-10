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

  it("streams a v2 business backup, records completion and enforces the export quota",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','player-v2','Example Player','active',?)",
      [new Date().toISOString()],
    );
    const endpoint="https://prism.test/api/v1/shops/source/data";
    const response=await app.fetch(new Request(`${endpoint}/export?scope=business`,{headers}),env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    const backup=await response.json() as {
      format:string;version:number;scope:string;tables:{players:Array<{id:string}>};
    };
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.version).toBe(2);
    expect(backup.scope).toBe("business");
    expect(backup.tables.players.some(player=>player.id==="player-v2")).toBe(true);

    const exportJob=sqlite.query(
      "SELECT status FROM shop_data_exports WHERE shop_id='source' ORDER BY created_at DESC LIMIT 1",
    ).get() as {status:string}|null;
    expect(exportJob?.status).toBe("completed");

    const quota=await app.fetch(new Request(`${endpoint}/export-status`,{headers}),env);
    expect(quota.status).toBe(200);
    const quotaBody=await quota.json() as {data:{used:number;remaining:number}};
    expect(quotaBody.data.used).toBe(1);
    expect(quotaBody.data.remaining).toBe(0);

    const second=await app.fetch(new Request(`${endpoint}/export?scope=business`,{headers}),env);
    expect(second.status).toBe(429);
    const secondBody=await second.json() as {error:{code:string}};
    expect(secondBody.error.code).toBe("EXPORT_MONTHLY_LIMIT");
    sqlite.close();
  });

  it("restores a v2 business backup through staged parts and an atomic import",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','staged-player','Staged Player','active',?)",
      [new Date().toISOString()],
    );
    const source="https://prism.test/api/v1/shops/source/data";
    const destination="https://prism.test/api/v1/shops/destination/data";
    const exported=await app.fetch(new Request(`${source}/export?scope=business`,{headers}),env);
    expect(exported.status).toBe(200);
    const backup=await exported.json() as {
      version:number;
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    expect(backup.version).toBe(2);
    const {tables,...header}=backup;
    const post=async(url:string,payload:unknown)=>{
      return app.fetch(new Request(url,{
        method:"POST",headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify(payload),
      }),env);
    };
    const created=await post(`${destination}/imports`,header);
    expect(created.status).toBe(200);
    const {jobId}=((await created.json()) as {data:{jobId:string}}).data;
    expect(jobId).toBeTruthy();
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const response=await post(`${destination}/imports/${jobId}/parts`,{table,part,rows});
      expect(response.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,rows.length]));
    const checked=await post(`${destination}/imports/${jobId}/preview`,{counts,parts:part});
    expect(checked.status).toBe(200);
    const preview=((await checked.json()) as {data:{canImport:boolean;errors:string[];fingerprint:string}}).data;
    expect(preview.errors).toEqual([]);
    expect(preview.canImport).toBe(true);

    // The target must remain unchanged between preview and apply; a stale
    // fingerprint cannot overwrite a store that has acquired business rows.
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('destination','concurrent-player','Concurrent','active',?)",
      [new Date().toISOString()],
    );
    const stale=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(sqlite.query("SELECT id FROM players WHERE shop_id='destination' AND id='staged-player'").get()).toBeNull();
    sqlite.run("DELETE FROM players WHERE shop_id='destination' AND id='concurrent-player'");
    // The 0036 revision triggers intentionally keep a stale import locked until a fresh preview.
    const refreshed=await post(`${destination}/imports/${jobId}/preview`,{counts,parts:part});
    expect(refreshed.status).toBe(200);
    const freshPreview=((await refreshed.json()) as {data:{canImport:boolean;fingerprint:string}}).data;
    expect(freshPreview.canImport).toBe(true);
    const freshFingerprint=freshPreview.fingerprint;

    const operationId=crypto.randomUUID();
    const applied=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId,
    });
    expect(applied.status).toBe(200);
    const repeated=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await applied.json());
    const conflicting=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId:crypto.randomUUID(),
    });
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as {error:{code:string}}).error.code).toBe("OPERATION_CONFLICT");
    const migrated=sqlite.query(
      "SELECT id,display_name FROM players WHERE shop_id='destination' AND id='staged-player'",
    ).get() as {id:string;display_name:string}|null;
    expect(migrated?.display_name).toBe("Staged Player");
    const job=sqlite.query("SELECT status FROM shop_data_jobs WHERE id=?").get(jobId) as {status:string}|null;
    expect(job?.status).toBe("completed");
    sqlite.close();
  });

  it("round-trips a v2 configuration backup with the original settings and shop profile",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const source="https://prism.test/api/v1/shops/source/data";
    const dest="https://prism.test/api/v1/shops/destination/data";
    const call=async(url:string,body:unknown)=>app.fetch(new Request(url,{
      method:"POST",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify(body),
    }),env);
    const exp=await app.fetch(new Request(`${source}/export?scope=configuration`,{headers}),env);
    expect(exp.status).toBe(200);
    const backup=await exp.json() as {
      format:string; version:number;scope:string;
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    expect(backup.version).toBe(2);
    expect(backup.scope).toBe("configuration");
    const {tables,...header}=backup;
    const created=await call(`${dest}/imports`,header);
    expect(created.status).toBe(200);
    const {jobId}=((await created.json()) as {data:{jobId:string}}).data;
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const uploaded=await call(`${dest}/imports/${jobId}/parts`,{table,part,rows});
      expect(uploaded.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
    const checked=await call(`${dest}/imports/${jobId}/preview`,{counts,parts:part});
    expect(checked.status).toBe(200);
    const preview=((await checked.json()) as {data:{canImport:boolean;errors:string[];fingerprint:string}}).data;
    expect(preview.canImport).toBe(true);
    expect(preview.errors).toEqual([]);
    const applied=await call(`${dest}/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),
    });
    expect(applied.status).toBe(200);
    const settings=sqlite.query(
      "SELECT value_json FROM app_settings WHERE shop_id='destination' AND key='venue.operations'",
    ).get() as {value_json:string}|null;
    expect(JSON.parse(settings?.value_json??"{}").coinCooldownMs).toBe(42_000);
    expect((sqlite.query("SELECT name FROM shops WHERE id='destination'").get() as {name:string}).name).toBe("source");
    sqlite.close();
  });
  it("requires explicit confirmation to overwrite live business records while preserving platform credentials",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const now=new Date().toISOString();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','replacement-player','Restored Player','active',?)",
      [now],
    );
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('destination','old-player','Previous Player','active',?)",
      [now],
    );
    const beforeSessions=sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get() as {count:number};
    const request=async(url:string,payload:unknown)=>app.fetch(new Request(url,{
      method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(payload),
    }),env);
    const source="https://prism.test/api/v1/shops/source/data";
    const target="https://prism.test/api/v1/shops/destination/data";
    const exportResult=await app.fetch(new Request(source+"/export?scope=business",{headers}),env);
    expect(exportResult.status).toBe(200);
    const backup=await exportResult.json() as {
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    const {tables,...manifest}=backup;
    const created=await request(target+"/imports",manifest);
    expect(created.status).toBe(200);
    const jobId=((await created.json()) as {data:{jobId:string}}).data.jobId;
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const uploaded=await request(target+`/imports/${jobId}/parts`,{table,part,rows});
      expect(uploaded.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
    const previewed=await request(target+`/imports/${jobId}/preview`,{counts,parts:part});
    expect(previewed.status).toBe(200);
    const preview=((await previewed.json()) as {data:{
      canImport:boolean;fingerprint:string;target:{records:number;mode:string}
    }}).data;
    expect(preview.canImport).toBe(true);
    expect(preview.target.mode).toBe("replace");
    expect(preview.target.records).toBeGreaterThan(0);
    const operationId=crypto.randomUUID();
    const denied=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as {error:{code:string}}).error.code).toBe("IMPORT_OVERWRITE_REQUIRED");
    const unchanged = sqlite.query("SELECT display_name FROM players WHERE shop_id='destination' AND id='old-player'").get() as {display_name:string}|null;
    expect(unchanged?.display_name).toBe("Previous Player");
    const applied=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,overwrite:true,
    });
    expect(applied.status).toBe(200);
    const records=sqlite.query(
      "SELECT id FROM players WHERE shop_id='destination' ORDER BY id",
    ).all() as Array<{id:string}>;
    expect(records).toEqual([{id:"replacement-player"}]);
    const afterSessions=sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get() as {count:number};
    expect(afterSessions).toEqual(beforeSessions);
    const repeated=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,overwrite:true,
    });
    expect(repeated.status).toBe(200);
    expect(sqlite.query("SELECT id FROM players WHERE shop_id='destination' ORDER BY id").all()).toEqual(records);
    sqlite.close();
  });
});
