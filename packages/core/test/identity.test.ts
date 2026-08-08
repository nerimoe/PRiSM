import { describe, expect, test } from "bun:test";
import {
  externalIdentityKey,
  normalizeExternalIdentity,
  parseIdentityKey,
  PrismDomainError,
} from "../src/index";

describe("external identity helpers", () => {
  test("normalizes structured identities", () => {
    expect(
      normalizeExternalIdentity({
        provider: " QQ ",
        subject: " 123456 ",
      }),
    ).toEqual({
      provider: "qq",
      subject: "123456",
    });
  });

  test("parses TYPE subject shorthand", () => {
    expect(parseIdentityKey("QQ:123456")).toEqual({
      provider: "qq",
      subject: "123456",
    });
    expect(parseIdentityKey("AIME:0111222333")).toEqual({
      provider: "aime",
      subject: "0111222333",
    });
  });

  test("preserves colons inside the shorthand subject", () => {
    expect(parseIdentityKey("telegram:abc:def")).toEqual({
      provider: "telegram",
      subject: "abc:def",
    });
  });

  test("formats normalized identity keys", () => {
    expect(
      externalIdentityKey({
        provider: " QQ ",
        subject: " 123456 ",
      }),
    ).toBe("qq:123456");
  });

  test("rejects invalid identities with domain error code", () => {
    const invalidValues = [
      () => parseIdentityKey("qq"),
      () => parseIdentityKey(":123456"),
      () => parseIdentityKey("qq:"),
      () => normalizeExternalIdentity({ provider: " ", subject: "123456" }),
      () => normalizeExternalIdentity({ provider: "qq", subject: " " }),
    ];

    for (const action of invalidValues) {
      expect(action).toThrow(
        expect.objectContaining({
          name: "PrismDomainError",
          code: "INVALID_EXTERNAL_IDENTITY",
        }) as PrismDomainError,
      );
    }
  });
});
