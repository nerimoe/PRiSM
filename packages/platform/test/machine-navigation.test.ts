import { expect, test } from "bun:test";
import app from "../src/index";
import { mintMachineTicket, readMachineTicket, resolveMachineSession } from "../src/machine-session";
import { createTestRateLimits } from "./rate-limit-fixture";
import type { Env, MachineRow } from "../src/types";
import type { Context } from "hono";
import type { AppBindings } from "../src/types";

const secret = "test-navigation-secret";
test("QR redirect is opaque, uncacheable and never reads D1 even with a login cookie", async () => {
  const env = { SESSION_SECRET: secret, ...createTestRateLimits().bindings,
    DB: { prepare() { throw new Error("QR must not query or insert D1"); } } } as unknown as Env;
  const response = await app.fetch(new Request("https://test/t/shop/device", { headers: { cookie: "arcadelink_session=logged-in" } }), env);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const url = new URL(response.headers.get("location")!, "https://test");
  expect(url.pathname).toBe("/m");
  expect(url.search).toBe("");
  const ticket = new URLSearchParams(url.hash.slice(1)).get("ticket")!;
  expect(ticket).not.toContain("shop");
  expect(await readMachineTicket(secret, ticket)).toMatchObject({ shopCode: "shop", publicId: "device" });
});

test("navigation tickets use fresh nonces, expire and reject tampering and other secrets", async () => {
  const now = Date.now();
  const first = await mintMachineTicket(secret, "shop", "device", now);
  const second = await mintMachineTicket(secret, "shop", "device", now);
  expect(first.ticket).not.toBe(second.ticket);
  expect(first.expiresIn).toBe(300);
  await expect(readMachineTicket(secret, first.ticket, now + 300_000)).rejects.toMatchObject({ status: 410 });
  await expect(readMachineTicket("other", first.ticket)).rejects.toMatchObject({ status: 410 });
  const changed = first.ticket.slice(0, -8) + "AAAAAAAA";
  await expect(readMachineTicket(secret, changed)).rejects.toMatchObject({ status: 410 });
  await expect(mintMachineTicket(secret, "../../", "device")).rejects.toMatchObject({ status: 404 });
});

function context(machine: Partial<MachineRow> | null) {
  const queries: string[] = [];
  const c = { env: { SESSION_SECRET: secret, DB: { prepare(sql: string) {
    queries.push(sql); return { bind() { return this; }, async first() { return machine; } };
  } } } } as unknown as Context<AppBindings>;
  return { c, queries };
}
test("resolution performs one machine query and checks current enabled state, shop and route", async () => {
  const { ticket } = await mintMachineTicket(secret, "shop", "device");
  const valid = context({ public_id: "device", shop_public_id: "shop", enabled: 1 });
  expect((await resolveMachineSession(valid.c, ticket)).publicId).toBe("device");
  expect(valid.queries).toHaveLength(1);
  expect(valid.queries[0]).not.toContain("machine_tickets");
  await expect(resolveMachineSession(valid.c, ticket, "other-device")).rejects.toMatchObject({ status: 410 });
  expect(valid.queries).toHaveLength(1);
  await expect(resolveMachineSession(context({ public_id: "device", shop_public_id: "other-shop", enabled: 1 }).c, ticket)).rejects.toMatchObject({ status: 404 });
  await expect(resolveMachineSession(context({ public_id: "device", shop_public_id: "shop", enabled: 0 }).c, ticket)).rejects.toMatchObject({ status: 404 });
  await expect(resolveMachineSession(context(null).c, ticket)).rejects.toMatchObject({ status: 404 });
  const legacy = context({ public_id: "device", shop_public_id: "shop", enabled: 1 });
  await resolveMachineSession(legacy.c, "legacy-ticket");
  expect(legacy.queries).toHaveLength(1);
  expect(legacy.queries[0]).toContain("JOIN machine_tickets");
});
