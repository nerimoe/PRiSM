import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { merchantResourceRouter } from "../src/routes/platform/merchant-resources.js";
import { responseTimeMiddleware } from "../src/middleware/response-time.js";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return { bind(...values: SqlValue[]) {
      return {
        async first<T=unknown>() { return (db.query(sql).get(...values) as T | null) ?? null; },
        async all<T=unknown>() { return { results: db.query(sql).all(...values) as T[] }; },
        async run() { const result=db.run(sql,values); return {meta:{changes:result.changes}}; },
      };
    } };
  }
  async batch(statements: readonly D1BoundStatementLike[]) {
    const results=[];
    for(const stmt of statements) results.push(await stmt.run());
    return results;
  }
}

function fixture() {
  const sqlite=new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shops(
      id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL,
      latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL,
      hero_data TEXT, hero_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE app_settings(shop_id TEXT,key TEXT,value_json TEXT,updated_at TEXT,PRIMARY KEY(shop_id,key));
    CREATE TABLE shop_billing_settings(
      shop_id TEXT PRIMARY KEY,billing_enabled INTEGER,auto_register INTEGER,
      identity_binding_required INTEGER,checkin_geo INTEGER,checkout_geo INTEGER,machine_geo INTEGER,
      entry_pricing_ids_json TEXT,bot_contact TEXT
    );
    CREATE TABLE machines(
      shop_id TEXT NOT NULL,id TEXT NOT NULL,public_id TEXT NOT NULL,name TEXT NOT NULL,
      hinata_url_encrypted TEXT NOT NULL DEFAULT '',hinata_password_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'machine',
      ha_binding_encrypted TEXT,ttlock_lock_id INTEGER,coin_key INTEGER NOT NULL DEFAULT 32,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0,mahjong_config_json TEXT,aliases_json TEXT NOT NULL DEFAULT '[]',
      relay_connection TEXT NOT NULL DEFAULT 'external',relay_token_hash TEXT,relay_channel TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resource_group_id TEXT,pricing_config_override_id TEXT,capacity INTEGER NOT NULL DEFAULT 0,occupancy_minutes INTEGER NOT NULL DEFAULT 15,PRIMARY KEY(shop_id,id)
    );
    CREATE TABLE machine_login_events(id TEXT,machine_id TEXT);
    CREATE TABLE player_operations(id TEXT,device_id TEXT);
    CREATE TABLE machine_tickets(machine_id TEXT,token_hash TEXT);
    CREATE TABLE mahjong_seats(shop_id TEXT,machine_id TEXT,player_id TEXT);
  `);
  sqlite.run("CREATE TABLE players(shop_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(shop_id,id))");
  for(const statement of deviceEventSchema)sqlite.run(statement);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters) VALUES ('shop-1','shop-code','Test Shop',0,0,80)");
  const db=new SqliteD1(sqlite);
  const env={DB:db,SESSION_SECRET:"session-secret",URL_ENCRYPTION_KEY:"unit-test-encryption-key"} as unknown as Env;
  const app=new Hono<AppBindings>();
  app.use("*",async(c,next)=> {
    c.set("user",{id:"admin-1",role:"admin",username:"admin",displayName:"Admin",bannedAt:null});
    await next();
  });
  app.route("/api/v1/merchant",merchantResourceRouter);
  return {app,env,sqlite};
}

describe("pre-fork merchant machine lifecycle",()=>{
  it("returns a cursor and coin details so all stored history can be read across pages", async () => {
    const { app, env, sqlite } = fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','cab','cab','Cabinet')");
    const payload = { coins: 2, previousCredit: 4, credit: 6 };
    for (const id of ["a", "b", "c"]) {
      sqlite.run(`INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,payload_json,occurred_at)
        VALUES ('shop-1',?,'cab','hinata_io','signal','cabinet.coin','device',?,'2026-10-29T16:08:00.000Z')`, [id, JSON.stringify(payload)]);
    }
    const get = async (query: string) => (await (await app.fetch(new Request(
      `https://prism.test/api/v1/merchant/machines/cab/events?limit=2${query}`,
    ), env)).json()) as { events: { id: string; payload: unknown }[]; nextCursor: string | null };
    const first = await get("");
    expect(first.events.map((e) => e.id)).toEqual(["c", "b"]);
    expect(first.events[0]!.payload).toEqual(payload);
    expect(first.nextCursor).toBe("b");
    const last = await get(`&before=${first.nextCursor}`);
    expect(last.events.map((e) => e.id)).toEqual(["a"]);
    expect(last.nextCursor).toBeNull();
    sqlite.close();
  });

  it("lists a resource's history as what happened to it and what came through it, naming the other resource", async () => {
    const { app, env, sqlite } = fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','cab','cab','Cabinet'),('shop-1','bot','bot','前台 Bot')");
    const insert = (id: string, device: string, kind: string, name: string, via: string | null, viaResource: string | null, at: string) =>
      sqlite.run(
        `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,operation_id,origin,payload_json,occurred_at,via,via_resource_id)
         VALUES ('shop-1',?,?,'hinata_io',?,?,?,'platform','{}',?,?,?)`,
        [id, device, kind, name, kind === "signal" ? null : "op-1", at, via, viaResource],
      );
    insert("said", "bot", "signal", "bot.command", "bot", "bot", "2026-10-29T16:00:01.000Z");
    insert("asked", "cab", "request", "coin", "bot", "bot", "2026-10-29T16:00:02.000Z");
    insert("page", "cab", "request", "coin", "page", null, "2026-10-29T16:00:03.000Z");
    insert("old", "cab", "request", "coin", null, null, "2026-10-29T16:00:04.000Z");
    type Listed = { id: string; device: { id: string; name: string } | null; via: { channel: string; resource: { id: string; name: string } | null } | null };
    const events = async (id: string, query = "") => ((await (await app.fetch(new Request(
      `https://prism.test/api/v1/merchant/machines/${id}/events${query}`,
    ), env)).json()) as { events: Listed[]; nextCursor: string | null });

    // The bot: the command said to it once, and the coin it asked another resource for.
    const bot = await events("bot");
    expect(bot.events.map((e) => [e.id, e.device, e.via])).toEqual([
      ["asked", { id: "cab", name: "Cabinet" }, { channel: "bot", resource: null }],
      ["said", null, { channel: "bot", resource: null }],
    ]);
    // The cabinet: everything that happened to it, saying which came through the bot.
    const cab = await events("cab");
    expect(cab.events.map((e) => [e.id, e.device, e.via])).toEqual([
      ["old", null, null],
      ["page", null, { channel: "page", resource: null }],
      ["asked", null, { channel: "bot", resource: { id: "bot", name: "前台 Bot" } }],
    ]);
    // Paging runs across both halves.
    const first = await events("bot", "?limit=1");
    expect([first.events.map((e) => e.id), first.nextCursor]).toEqual([["asked"], "asked"]);
    const rest = await events("bot", `?limit=1&before=${first.nextCursor}`);
    expect([rest.events.map((e) => e.id), rest.nextCursor]).toEqual([["said"], null]);
    sqlite.close();
  });

  it("returns operation history in the resource's shop zone, including midnight and daylight saving", async () => {
    const { app, env, sqlite } = fixture();
    const api = new Hono<AppBindings>();
    api.use("*", responseTimeMiddleware);
    api.route("/", app);
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','cab','cab','Cabinet')");
    for (const [zone, at, expected] of [
      ["Asia/Shanghai", "2026-10-29T16:08:00.000Z", "2026-10-30T00:08:00.000+08:00"],
      ["America/New_York", "2026-07-01T02:08:00.000Z", "2026-06-30T22:08:00.000-04:00"],
      ["America/New_York", "2026-01-01T02:08:00.000Z", "2025-12-31T21:08:00.000-05:00"],
      ["UTC", "2026-10-29T16:08:00.000Z", "2026-10-29T16:08:00.000Z"],
    ] as const) {
      sqlite.run("INSERT OR REPLACE INTO app_settings(shop_id,key,value_json) VALUES ('shop-1','store.profile',?)", [JSON.stringify({ timeZone: zone })]);
      sqlite.run(`INSERT OR REPLACE INTO device_events(shop_id,id,device_id,capability,kind,name,origin,occurred_at)
        VALUES ('shop-1','event','cab','power','request','power.off','platform',?)`, [at]);
      const response = await api.fetch(new Request("https://prism.test/api/v1/merchant/machines/cab/events"), env);
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { events: { at: string }[] } };
      expect(body.data.events[0]!.at).toBe(expected);
      expect(sqlite.query("SELECT occurred_at FROM device_events WHERE id='event'").get()).toEqual({ occurred_at: at });
    }
    sqlite.close();
  });
  it("creates, updates and deletes against the actual shop-scoped machine columns",async()=>{
    const {app,env,sqlite}=fixture();
    const created=await app.fetch(new Request("https://prism.test/api/v1/merchant/machines",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({shopId:"shop-1",name:"Arcade Cabinet",kind:"machine",enabled:true,coinKey:32}),
    }),env);
    expect(created.status).toBe(201);
    const first=await created.json() as {machine:{id:string;publicId:string;shopId:string;name:string}};
    expect(first.machine.shopId).toBe("shop-1");
    expect(first.machine.name).toBe("Arcade Cabinet");
    const stored=sqlite.query("SELECT name,shop_id,public_id FROM machines WHERE id=?").get(first.machine.id) as {name:string;shop_id:string;public_id:string};
    expect(stored.public_id).toBe(first.machine.publicId);
    expect(stored.shop_id).toBe("shop-1");
    const patched=await app.fetch(new Request(`https://prism.test/api/v1/merchant/machines/${first.machine.id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Renamed Cabinet",aliases:["arcade","cabinet"]}),
    }),env);
    expect(patched.status).toBe(200);
    const updated=await patched.json() as {machine:{name:string;aliases:string[]}};
    expect(updated.machine.name).toBe("Renamed Cabinet");
    expect(updated.machine.aliases).toEqual(["arcade","cabinet"]);
    const removed=await app.fetch(new Request(`https://prism.test/api/v1/merchant/machines/${first.machine.id}`,{method:"DELETE"}),env);
    expect(removed.status).toBe(200);
    expect(sqlite.query("SELECT id FROM machines WHERE id=?").get(first.machine.id)).toBeNull();
  });
  it("binds capabilities and keeps them through an edit that does not mention them",async()=>{
    const {app,env,sqlite}=fixture();
    const send=(method:string,path:string,body:unknown)=>app.fetch(new Request(`https://prism.test/api/v1/merchant${path}`,{
      method,headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }),env);
    const created=await send("POST","/machines",{
      shopId:"shop-1",name:"Cabinet",coinKey:40,coinAfterSwipe:true,
      hinataUrl:"https://relay.example/io",hinataPassword:"secret-pass",
      homeAssistant:{url:"https://ha.example",entityId:"switch.cabinet",token:"ha-token"},
      ttlockLockId:77,
    });
    expect(created.status).toBe(201);
    const {machine}=await created.json() as {machine:Record<string,unknown>&{id:string}};
    expect(machine).toMatchObject({
      // An external relay never reports a card being taken, so no coin follows one.
      hasHinata:true,hinataUrl:"https://relay.example/io",hasPassword:true,coinKey:40,coinAfterSwipe:false,
      homeAssistant:{url:"https://ha.example",entityId:"switch.cabinet"},ttlockLockId:77,relayConnection:"external",
    });
    const rows=()=>sqlite.query("SELECT capability,config_json,secret_json FROM device_capabilities ORDER BY capability").all() as {capability:string;config_json:string;secret_json:string}[];
    expect(rows().map(r=>r.capability)).toEqual(["coin","door","hinata_io","power"]);
    // Secrets are stored encrypted, never in the clear.
    expect(JSON.stringify(rows())).not.toContain("secret-pass");
    expect(JSON.stringify(rows())).not.toContain("ha-token");
    const before=rows();

    const renamed=await send("PATCH",`/machines/${machine.id}`,{name:"Renamed"});
    expect(renamed.status).toBe(200);
    expect(rows().map(r=>[r.capability,r.config_json,r.secret_json])).toEqual(before.map(r=>[r.capability,r.config_json,r.secret_json]));

    // Changing the Home Assistant entity without a token keeps the stored token.
    await send("PATCH",`/machines/${machine.id}`,{homeAssistant:{url:"https://ha.example",entityId:"switch.other"}});
    const listed=await (await app.fetch(new Request("https://prism.test/api/v1/merchant/machines?shopId=shop-1"),env)).json() as {machines:Record<string,unknown>[]};
    expect(listed.machines[0]).toMatchObject({homeAssistant:{entityId:"switch.other"},coinKey:40});

    const unbound=await send("PATCH",`/machines/${machine.id}`,{homeAssistant:null,ttlockLockId:null,hinataUrl:null,hinataPassword:null});
    expect(unbound.status).toBe(200);
    expect(rows()).toEqual([]);
  });
  it("keeps a cabinet's named keys, reads an older coin key as one called 投币, and takes the coin key from the one chosen",async()=>{
    const {app,env}=fixture();
    const send=(method:string,path:string,body:unknown)=>app.fetch(new Request(`https://prism.test/api/v1/merchant${path}`,{
      method,headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }),env);
    const created=await send("POST","/machines",{shopId:"shop-1",name:"Cabinet",coinKey:40,hinataUrl:"https://relay.example/io",hinataPassword:"secret-pass"});
    const {machine}=await created.json() as {machine:Record<string,unknown>&{id:string}};
    expect(machine).toMatchObject({keys:[{id:"coin",name:"投币",key:40}],coinKeyId:"coin",coinKey:40});

    const saved=await send("PATCH",`/machines/${machine.id}`,{
      hinataUrl:"https://relay.example/io",keys:[{id:"coin",name:"投币",key:40},{name:"服务",key:"F1"},{name:"测试",key:"Enter"}],coinKeyId:"coin",
    });
    expect(saved.status).toBe(200);
    const after=(await saved.json() as {machine:{keys:{id:string;name:string;key:number}[];coinKeyId:string|null;coinKey:number}}).machine;
    expect(after.keys.map(k=>[k.name,k.key])).toEqual([["投币",40],["服务",112],["测试",13]]);
    expect(after).toMatchObject({coinKeyId:"coin",coinKey:40});

    // Dropping the coin key leaves the cabinet without a coin, its other keys kept.
    const service=after.keys[1]!;
    const noCoin=await send("PATCH",`/machines/${machine.id}`,{hinataUrl:"https://relay.example/io",keys:[service],coinKeyId:"coin"});
    expect((await noCoin.json() as {machine:Record<string,unknown>}).machine).toMatchObject({keys:[service],coinKeyId:null,coinKey:0});

    const unreadable=await send("PATCH",`/machines/${machine.id}`,{hinataUrl:"https://relay.example/io",keys:[{name:"坏",key:"!!"}]});
    expect(unreadable.status).toBe(400);
  });

  it("binds an air conditioner as its own capability and reuses the power token for the same Home Assistant",async()=>{
    const {app,env,sqlite}=fixture();
    const send=(method:string,path:string,body:unknown)=>app.fetch(new Request(`https://prism.test/api/v1/merchant${path}`,{
      method,headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }),env);
    // A switch is power, not an air conditioner; the schema refuses it.
    const wrong=await send("POST","/machines",{shopId:"shop-1",name:"包间",climate:{url:"https://ha.example",entityId:"switch.ac",token:"t"}});
    expect(wrong.status).not.toBe(201);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM machines").get()).toEqual({n:0});
    const missing=await send("POST","/machines",{shopId:"shop-1",name:"包间",climate:{url:"https://ha.example",entityId:"climate.room"}});
    expect(missing.status).toBe(400);
    const created=await send("POST","/machines",{
      shopId:"shop-1",name:"包间",
      homeAssistant:{url:"https://ha.example",entityId:"switch.room",token:"ha-token"},
      climate:{url:"https://ha.example",entityId:"climate.lumi_cn_974741205_mcn02"},
    });
    expect(created.status).toBe(201);
    const {machine}=await created.json() as {machine:Record<string,unknown>&{id:string;actions:{name:string;capability:string}[]}};
    expect(machine).toMatchObject({climate:{url:"https://ha.example",entityId:"climate.lumi_cn_974741205_mcn02"}});
    expect(machine.actions.filter(a=>a.capability==="climate").map(a=>a.name)).toEqual([
      "climate.on","climate.off","climate.set_mode","climate.set_temperature","climate.set_fan_mode",
    ]);
    const rows=sqlite.query("SELECT capability FROM device_capabilities ORDER BY capability").all();
    expect(rows).toEqual([{capability:"climate"},{capability:"power"}]);
    expect(JSON.stringify(sqlite.query("SELECT secret_json FROM device_capabilities").all())).not.toContain("ha-token");
    await send("PATCH",`/machines/${machine.id}`,{climate:null});
    expect(sqlite.query("SELECT capability FROM device_capabilities").all()).toEqual([{capability:"power"}]);
  });
  it("does not delete machines that have historical commands",async()=>{
    const {app,env,sqlite}=fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','machine-old','m-old','Archived Machine')");
    sqlite.run(`INSERT INTO device_operations(shop_id,id,device_id,capability,action,status,payload_json,requested_at)
      VALUES ('shop-1','command-1','machine-old','power','power.on','succeeded','{}','2026-01-01T00:00:00.000Z')`);
    const res=await app.fetch(new Request("https://prism.test/api/v1/merchant/machines/machine-old",{method:"DELETE"}),env);
    expect(res.status).toBe(409);
    expect(sqlite.query("SELECT id FROM machines WHERE id='machine-old'").get()).not.toBeNull();
  });
});
