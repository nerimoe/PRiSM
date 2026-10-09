import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { destroySession } from "../../middleware/auth.js";
import { passkeysRouter } from "./passkeys.js";

export const authRouter = new Hono<AppBindings>();

// Platform accounts are created by MuNET OAuth. Passkeys authenticate existing users.
// Never issue sessions from caller-supplied usernames alone.
authRouter.route("/passkey", passkeysRouter);

authRouter.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRouter.get("/me", async (c) => {
  return c.json({ user: c.get("user") });
});
