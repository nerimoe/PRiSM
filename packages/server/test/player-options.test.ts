import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@prism/page-protocol";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const OWNER_TOKEN = "owner-options-token";
const PLAYER_TOKEN = "player-options-token";

async function optionsFixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) {
      sqlite.run(sql);
    }
  }
  sqlite.run(
    "INSERT INTO users(id,role,created_at,updated_at) VALUES ('owner-u','user',?,?),('player-u','user',?,?)",
    [NOW, NOW, NOW, NOW],
  );
  sqlite.run(
    "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('s-owner','owner-u',?,?),('s-player','player-u',?,?)",
    [
      await sha256(OWNER_TOKEN),
      new Date(Date.now() + 86_400_000).toISOString(),
      await sha256(PLAYER_TOKEN),
      new Date(Date.now() + 86_400_000).toISOString(),
    ],
  );
  sqlite.run(
    "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop-1','arcade','Arcade',0,0,80,'owner-u')",
  );
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('sm-1','shop-1','owner-u','owner')");
  sqlite.run(
    "INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required) VALUES ('shop-1',1,1,0)",
  );
  sqlite.run(
    "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop-1','p-1','Player One','active',?)",
    [NOW],
  );
  sqlite.run(
    "INSERT INTO player_identities(shop_id,provider,subject,player_id,created_at) VALUES ('shop-1','web-account','player-u','p-1',?)",
    [NOW],
  );

  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    SESSION_SECRET: "session-secret",
    URL_ENCRYPTION_KEY: "unit-test-key",
    RATE_LIMIT_10: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const app = createApp();
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`https://prism.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
    const json = (await res.json()) as any;
    return { status: res.status, body: json?.data ?? json };
  };
  return { sqlite, call };
}

describe("player options, shop privacy setting, and server-driven options sheet", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("rejects non-playerVisible option reads/writes and hides privacyMode in API and server-driven pages when shop disables it", async () => {
    const { sqlite, call } = await optionsFixture();

    const shopInfoOff = await call("GET", "/api/v1/shops/arcade", PLAYER_TOKEN);
    expect(shopInfoOff.status).toBe(200);
    expect(shopInfoOff.body.shop.privacyModeEnabled).toBe(false);

    const listOff = await call("GET", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN);
    expect(listOff.status).toBe(200);
    expect(listOff.body).toEqual({ options: {} });

    // Server-driven shop page hides "options" tab and view=options omits privacyMode when shop disables it.
    const shopPageOff = await call("GET", "/api/v1/shops/arcade/player/page?view=shop", PLAYER_TOKEN);
    expect(shopPageOff.status).toBe(200);
    expect((shopPageOff.body as Page).accountMenu?.tabs.map((t) => t.id)).not.toContain("options");

    const optionsSheetOff = await call("GET", "/api/v1/shops/arcade/player/page?view=options", PLAYER_TOKEN);
    expect(optionsSheetOff.status).toBe(200);
    expect((optionsSheetOff.body as Page).blocks).toEqual([
      { kind: "text", id: "options-empty", text: "暂无可用选项", style: "status", icon: "options", level: "muted" },
    ]);

    const readForbidden = await call("GET", "/api/v1/shops/arcade/player/options/excludeFromReports", PLAYER_TOKEN);
    expect(readForbidden.status).toBe(403);
    expect(readForbidden.body.error.code).toBe("PLAYER_OPTION_FORBIDDEN");

    const putForbidden = await call("PUT", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN, {
      excludeFromReports: true,
    });
    expect(putForbidden.status).toBe(403);
    expect(putForbidden.body.error.code).toBe("PLAYER_OPTION_FORBIDDEN");

    const patchForbidden = await call("PATCH", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN, {
      excludeFromReports: false,
    });
    expect(patchForbidden.status).toBe(403);
    expect(patchForbidden.body.error.code).toBe("PLAYER_OPTION_FORBIDDEN");

    const privacyDisabledWrite = await call("PUT", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN, {
      privacyMode: true,
    });
    expect(privacyDisabledWrite.status).toBe(403);
    expect(privacyDisabledWrite.body.error.code).toBe("PRIVACY_MODE_DISABLED");

    const staffSettingsBefore = await call("GET", "/api/v1/shops/arcade/staff/settings", OWNER_TOKEN);
    expect(staffSettingsBefore.status).toBe(200);
    expect(staffSettingsBefore.body.settings.privacyModeEnabled).toBe(false);

    const enableRes = await call("PUT", "/api/v1/shops/arcade/staff/settings", OWNER_TOKEN, {
      ...staffSettingsBefore.body.settings,
      privacyModeEnabled: true,
    });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.settings.privacyModeEnabled).toBe(true);

    const shopInfoOn = await call("GET", "/api/v1/shops/arcade", PLAYER_TOKEN);
    expect(shopInfoOn.status).toBe(200);
    expect(shopInfoOn.body.shop.privacyModeEnabled).toBe(true);

    const shopPageOn = await call("GET", "/api/v1/shops/arcade/player/page?view=shop", PLAYER_TOKEN);
    expect(shopPageOn.status).toBe(200);
    expect((shopPageOn.body as Page).accountMenu?.tabs.map((t) => t.id)).toContain("options");

    const optionsSheetOn = await call("GET", "/api/v1/shops/arcade/player/page?view=options", PLAYER_TOKEN);
    expect(optionsSheetOn.status).toBe(200);
    expect((optionsSheetOn.body as Page).blocks).toEqual([
      {
        kind: "toggle",
        id: "privacyMode",
        name: "privacyMode",
        label: "隐私模式",
        description: "开启后，机器人在群播报与查人列表中隐藏你的昵称。",
        defaultValue: false,
      },
      {
        kind: "button",
        id: "options-save",
        label: "保存",
        action: "options.save",
        style: "primary",
        collect: ["privacyMode"],
        enabled: true,
        needsLocation: false,
      },
    ]);

    const saveSheetAction = await call("POST", "/api/v1/shops/arcade/player/action", PLAYER_TOKEN, {
      view: "options",
      operationId: crypto.randomUUID(),
      action: "options.save",
      payload: { privacyMode: true },
    });
    expect(saveSheetAction.status).toBe(200);
    expect(saveSheetAction.body.ok).toBe(true);
    expect(saveSheetAction.body.notices[0]).toMatchObject({ code: "PLAYER_OPTIONS_SAVED", level: "success" });
    expect((saveSheetAction.body.page as Page).blocks[0]).toMatchObject({
      kind: "toggle",
      id: "privacyMode",
      defaultValue: true,
    });

    // Crafted options.save attempting to modify excludeFromReports is rejected.
    const forbiddenSheetAction = await call("POST", "/api/v1/shops/arcade/player/action", PLAYER_TOKEN, {
      view: "options",
      operationId: crypto.randomUUID(),
      action: "options.save",
      payload: { excludeFromReports: true },
    });
    expect(forbiddenSheetAction.status).toBe(200);
    expect(forbiddenSheetAction.body.ok).toBe(false);
    expect(forbiddenSheetAction.body.notices[0]).toMatchObject({ code: "PLAYER_OPTION_FORBIDDEN" });

    const listOn = await call("GET", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN);
    expect(listOn.status).toBe(200);
    expect(listOn.body).toEqual({ options: { privacyMode: true } });

    const disablePlayerPrivacy = await call("PUT", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN, {
      privacyMode: false,
    });
    expect(disablePlayerPrivacy.status).toBe(200);
    expect(disablePlayerPrivacy.body.options).toEqual({ privacyMode: false });

    // Mixing a forbidden option with a visible one is rejected atomically.
    const mixedWrite = await call("PUT", "/api/v1/shops/arcade/player/options", PLAYER_TOKEN, {
      privacyMode: true,
      excludeFromReports: true,
    });
    expect(mixedWrite.status).toBe(403);
    expect(mixedWrite.body.error.code).toBe("PLAYER_OPTION_FORBIDDEN");

    // Staff can read and update both excludeFromReports and privacyMode.
    const staffOptions = await call("GET", "/api/v1/shops/arcade/staff/players/p-1/options", OWNER_TOKEN);
    expect(staffOptions.status).toBe(200);
    expect(staffOptions.body).toEqual({
      options: { excludeFromReports: false, privacyMode: false },
      meta: { isStaff: false, privacyModeEnabled: true },
    });

    const staffUpdate = await call("PUT", "/api/v1/shops/arcade/staff/players/p-1/options", OWNER_TOKEN, {
      excludeFromReports: true,
      privacyMode: true,
    });
    expect(staffUpdate.status).toBe(200);
    expect(staffUpdate.body.options).toEqual({ excludeFromReports: true, privacyMode: true });

    sqlite.close();
  });
});
