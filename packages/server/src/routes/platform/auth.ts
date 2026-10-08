import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { destroySession } from "../../middleware/auth.js";
import { passkeysRouter } from "./passkeys.js";

export const authRouter = new Hono<AppBindings>();

// MuNET OAuth provisions platform accounts; Passkeys authenticate existing users.
// Never issue a platform session solely from a caller-supplied username.
authRouter.route("/passkey", passkeysRouter);

authRouter.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRouter.get("/me", async (c) => {
  const user = c.get("user");
  return c.json({ user });
});
