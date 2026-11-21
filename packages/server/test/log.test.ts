import { afterEach, expect, it, spyOn } from "bun:test";
import { logLine, loggedPath, logger, requestLine } from "../src/log.js";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
/** What the console was handed, by method. */
function capture() {
  const lines: Array<[string, Record<string, unknown>]> = [];
  for (const level of ["info", "warn", "error"] as const)
    spies.push(spyOn(console, level).mockImplementation((line: Record<string, unknown>) => { lines.push([level, line]); }));
  return lines;
}

it("says which module wrote a line, at which level, as a line that reads on its own", () => {
  const lines = capture();
  const log = logger("shop-hub");
  log.info("board snapshot sent", { shopId: "shop" });
  log.warn("watcher lease ran out", { event: "watcher_lost", machineId: "m1" });
  log.error("board read failed", { error: new TypeError("no such table") });
  expect(lines.map(([level, line]) => [level, line.message, line.kind, line.module, line.level])).toEqual([
    ["info", "[shop-hub] board snapshot sent", "app", "shop-hub", "info"],
    ["warn", "[shop-hub] watcher lease ran out", "app", "shop-hub", "warn"],
    ["error", "[shop-hub] board read failed: no such table", "app", "shop-hub", "error"],
  ]);
  expect(lines[0]![1].shopId).toBe("shop");
  expect(lines[1]![1].event).toBe("watcher_lost");
  expect(lines[2]![1].error).toMatchObject({ name: "TypeError", message: "no such table" });
});

it("keeps what makes a line ours out of the caller's hands", () => {
  const line = logLine("app", "bot", "error", "command failed", { message: "x", kind: "request", module: "other", level: "info" });
  expect(line).toMatchObject({ message: "[bot] command failed", kind: "app", module: "bot", level: "error" });
});

it("writes an error that is not an Error as its words", () => {
  expect(logLine("app", "bot", "error", "failed", { error: "timeout" }).error).toEqual({ name: "string", message: "timeout" });
  expect(logLine("app", "bot", "error", "failed", { error: { code: 1 } }).error).toEqual({ name: "object", message: '{"code":1}' });
});

it("writes one request line, a failure as an error and a refusal as a warning, without the query", () => {
  const lines = capture();
  requestLine(new Request("https://link.example/api/v1/shops/demo/player/me?token=secret"), 200, 12.4);
  requestLine(new Request("https://link.example/api/v1/me", { method: "POST" }), 401, 3);
  requestLine(new Request("https://link.example/api/v1/me"), 503, 40);
  expect(lines.map(([level, line]) => [level, line.message, line.kind, line.module])).toEqual([
    ["info", "[http] GET /api/v1/shops/demo/player/me 200 12ms", "request", "http"],
    ["warn", "[http] POST /api/v1/me 401 3ms", "request", "http"],
    ["error", "[http] GET /api/v1/me 503 40ms", "request", "http"],
  ]);
  expect(JSON.stringify(lines)).not.toContain("secret");
});

it("keeps card and account numbers out of a logged path", () => {
  expect(loggedPath("/api/v1/shops/demo/players/p1/identities/aime/01234567890123456789")).toBe("/api/v1/shops/demo/players/p1/identities/aime/:subject");
  expect(loggedPath("/api/v1/bots/onebot/123456789/status")).toBe("/api/v1/bots/onebot/:number/status");
  expect(loggedPath("/api/v1/shops/demo/machines/m-1")).toBe("/api/v1/shops/demo/machines/m-1");
});
