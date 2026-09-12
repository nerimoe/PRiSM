import { describe, expect, it } from "vitest";
import { passkeyErrorMessage } from "./passkeys";

describe("passkeyErrorMessage", () => {
  it.each(["NotAllowedError", "AbortError"])("silently handles %s regardless of message", (name) => {
    const error = new Error("The operation could not be completed");
    error.name = name;
    expect(passkeyErrorMessage(error)).toBeNull();
  });

  it("keeps actual failures visible even if their message mentions cancel", () => {
    expect(passkeyErrorMessage(new Error("Unable to cancel the request"))).toBe("Unable to cancel the request");
    const error = new Error("The operation could not be completed");
    error.name = "SecurityError";
    expect(passkeyErrorMessage(error)).toBe("当前环境无法使用 Passkey");
  });
});
