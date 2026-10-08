import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { destroySession } from "../../middleware/auth.js";
import { passkeysRouter } from "./passkeys.js";

export const authRouter = new Hono<AppBindings>();

// Platform identities are provisioned by verified MuNET OAuth or Passkey flows.
// Do not add username-only local registration or login endpoints here.
authRouter.route("/passkey", passkeysRouter);

authRouter.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRouter.get("/me", async (c) => {
  const user = c.get("user");
  return c.json({ user });
});
