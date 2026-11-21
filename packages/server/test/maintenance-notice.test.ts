import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { DEPLOY_QUEUE_STALE_MS, deploymentControl, deployQueueSchema, writeFenceStatements, type MaintenanceNotice } from "../src/deployment-gate.js";
import { sha256 } from "../src/crypto.js";
import { maintenanceMessage } from "../src/resources/shop-events.js";
import type { Env } from "../src/bindings.js";

/** A live Worker of any release, two shops, and the deploy run holding its turn in the queue. */
async function fixture(options: { fresh?: boolean; state?: string; deployedByThisRun?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE shops(id TEXT PRIMARY KEY)");
  sqlite.run("INSERT INTO shops(id) VALUES ('a'),('b')");
  sqlite.run(deployQueueSchema);
  const token = "N".repeat(48);
  const heartbeat = Date.now() - (options.fresh === false ? DEPLOY_QUEUE_STALE_MS + 1000 : 0);
  sqlite.query("INSERT INTO prism_deploy_queue VALUES (?, 1, ?, ?, ?)").run("f".repeat(40), options.state ?? "deploying", await sha256(token), heartbeat);
  const told: Array<[string, MaintenanceNotice]> = [];
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    // The live release was deployed by an earlier run, with its own token; or by this run, once it is over.
    PRISM_DEPLOY_TOKEN_HASH: await sha256(options.deployedByThisRun ? token : "E".repeat(48)),
    PRISM_DEPLOY_PHASE: "live",
    PRISM_DEPLOY_REVISION: "e".repeat(40),
    SHOP_HUB: { getByName: (shopId: string) => ({ async maintenance(notice: MaintenanceNotice) { told.push([shopId, notice]); } }) },
  } as unknown as Env;
  const ask = (body: Record<string, unknown>, bearer = token) => deploymentControl(new Request("https://example.test/__prism_deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, async () => Response.json({ ok: true }));
  return { sqlite, ask, told };
}

describe("maintenance notices", () => {
  it("are taken by the live Worker from the deploy run holding the turn, and told to every shop", async () => {
    const { ask, told } = await fixture();
    const response = await ask({ action: "notice", stage: "ahead", minutes: 5, expectedMinutes: 3 });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, shops: 2, told: 2 });
    expect(told).toEqual([["a", { stage: "ahead", minutes: 5, expectedMinutes: 3 }], ["b", { stage: "ahead", minutes: 5, expectedMinutes: 3 }]]);
    await ask({ action: "notice", stage: "done" });
    expect(told.slice(2)).toEqual([["a", { stage: "done" }], ["b", { stage: "done" }]]);
  });

  it("are taken by the release this run just deployed, so \"done\" is told once it is live", async () => {
    const { ask, told } = await fixture({ deployedByThisRun: true });
    const response = await ask({ action: "notice", stage: "done" });
    expect(response?.status).toBe(200);
    expect(told).toEqual([["a", { stage: "done" }], ["b", { stage: "done" }]]);
  });

  it("are refused from anyone else: another token, a run gone quiet, a run only waiting, or anything but a notice", async () => {
    for (const [options, body, bearer] of [
      [{}, { action: "notice", stage: "done" }, "X".repeat(48)],
      [{ fresh: false }, { action: "notice", stage: "done" }, undefined],
      [{ state: "waiting" }, { action: "notice", stage: "done" }, undefined],
      [{}, { action: "begin" }, undefined],
    ] as const) {
      const { ask, told } = await fixture(options);
      expect((await ask(body, bearer))?.status).toBe(404);
      expect(told).toEqual([]);
    }
  });

  it("must say a sensible time ahead", async () => {
    const { ask, told } = await fixture();
    expect((await ask({ action: "notice", stage: "ahead", minutes: 500, expectedMinutes: 3 }))?.status).toBe(400);
    expect(told).toEqual([]);
  });

  it("leave the queue writable while the shop is fenced", () => {
    expect(writeFenceStatements(["prism_deploy_queue", "players"]).join("\n")).not.toContain("prism_deploy_queue");
  });

  it("are worded by the platform unless the shop wrote its own", () => {
    const words = (message: unknown) => (message as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    expect(words(maintenanceMessage({ stage: "ahead", minutes: 5, expectedMinutes: 3 }))).toBe("🛠 5 分钟后开始后端维护，预计 3 分钟内完成，期间暂停服务");
    expect(words(maintenanceMessage({ stage: "done" }))).toBe("✅ 后端维护完成，服务已恢复");
    expect(words(maintenanceMessage({ stage: "ahead", minutes: 0, expectedMinutes: 3 }))).toBe("🛠 即将开始后端维护，预计 3 分钟内完成，期间暂停服务");
    expect(words(maintenanceMessage({ stage: "ahead", minutes: 5, expectedMinutes: 3 }, { "announce.platform.maintenance.ahead": "{minutes} 分钟后维护" })))
      .toBe("5 分钟后维护");
  });
});
