import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The repo's web tests run without a DOM, so these assert the routing contract at the
// source level. The behavior they protect: `/t/:shopCode` is the ticket-free shop page,
// and it must not be confused with `/t/:shopCode/:publicId`, which mints a machine ticket.
const app = readFileSync(new URL("./ui/App.tsx", import.meta.url), "utf8");

describe("shop-only deep link routing", () => {
  it("renders the standalone shop page for a bare shop code", () => {
    expect(app).toMatch(/path="\/t\/:shopCode"\s+element=\{<ShopPage \/>\}/);
  });

  it("no longer sends a bare shop code to the expired machine page", () => {
    // The old redirect made the Bot's "到店校验" link a dead end.
    expect(app).not.toMatch(/path="\/t\/:shopCode"[\s\S]{0,120}?\/m\/expired/);
  });

  it("keeps the machine ticket route separate", () => {
    expect(app).toMatch(/path="\/m\/:ticket"/);
  });
});
