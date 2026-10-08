import { expect, test } from "bun:test";
import { Hono } from "hono";
import { enforceRateLimits } from "../src/risk";
import type { AppBindings, Env } from "../src/types";
import { createTestRateLimits } from "./rate-limit-fixture";

test("binding limiter rejects before work, keeps stable keys and returns Retry-After", async () => {
  const app = new Hono<AppBindings>();
  let writes = 0;
  app.post("/login", async c => {
    await enforceRateLimits(c, [{ key: "user:u", limit: 3, windowSeconds: 60 }]);
    writes++; return c.json({ ok: true });
  });
  const env = { ...createTestRateLimits().bindings } as unknown as Env;
  for (let i = 0; i < 3; i++) expect((await app.request("/login", { method: "POST" }, env)).status).toBe(200);
  for (let i = 0; i < 10; i++) {
    const response = await app.request("/login", { method: "POST" }, env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  }
  expect(writes).toBe(3);
  expect((await app.request("/login", { method: "POST" }, {} as Env)).status).toBe(503);
});
