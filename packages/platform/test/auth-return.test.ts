import { expect, test } from "bun:test";
import { isVenueReturn, munetFailureReturn, munetSuccessReturn } from "../src/auth-return";

test("new venue accounts return to the same machine with an optional Passkey suggestion", () => {
  for (const next of ["/m?ticket=opaque%2B%2F%3D&theme=dark#controls", "/m/legacy-ticket", "/t/shop/device?source=nfc#play", "/t/shop"]) {
    const before = new URL(next, "https://prism.test");
    const after = new URL(munetSuccessReturn(next, true), before.origin);
    expect(after.pathname).toBe(before.pathname);
    expect(after.hash).toBe(before.hash);
    for (const [key, value] of before.searchParams) expect(after.searchParams.get(key)).toBe(value);
    expect(after.searchParams.get("setup")).toBe("passkey");
    expect(munetSuccessReturn(next, false)).toBe(next);
  }
});

test("OAuth cancellation and errors return to the venue sign-in without losing the ticket", () => {
  for (const message of ["MuNET 授权已取消", "MuNET 授权无效，请重试"]) {
    const url = new URL(munetFailureReturn("/m?ticket=abc%2Bdef#controls", message), "https://prism.test");
    expect(url.pathname).toBe("/m");
    expect(url.searchParams.get("ticket")).toBe("abc+def");
    expect(url.searchParams.get("error")).toBe(message);
    expect(url.hash).toBe("#controls");
  }
});

test("ordinary account login keeps its existing destination and expired sessions are not onboarded", () => {
  expect(munetSuccessReturn("/cards", true)).toBe("/settings?setup=passkey&next=%2Fcards");
  expect(munetSuccessReturn("/merchant?shop=x", false)).toBe("/merchant?shop=x");
  expect(munetFailureReturn("/cards", "error")).toBe("/login?error=error&next=%2Fcards");
  for (const path of ["/m/expired", "/merchant", "/t", "/t/shop/device/extra", "//other.example/m"]) expect(isVenueReturn(path)).toBe(false);
});

test("the OAuth callback returns cancellation to the scanned page and clears OAuth cookies", async () => {
  const { default: app } = await import("../src/index");
  const next = "/m?ticket=opaque%2Bticket#play";
  const response = await app.request("https://prism.test/callback?error=access_denied", {
    headers: { cookie: `arcadelink_munet_next=${encodeURIComponent(next)}; arcadelink_munet_state=state` },
  }, { APP_ORIGIN: "https://prism.test" } as import("../src/types").Env);
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get("location")!, "https://prism.test");
  expect(target.pathname).toBe("/m");
  expect(target.searchParams.get("ticket")).toBe("opaque+ticket");
  expect(target.searchParams.get("error")).toBe("MuNET 授权已取消");
  expect(target.hash).toBe("#play");
  expect(response.headers.get("set-cookie")).toContain("arcadelink_munet_state=;");
  expect(response.headers.get("set-cookie")).toContain("arcadelink_munet_next=;");
});
