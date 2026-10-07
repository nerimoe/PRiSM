import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";

export const healthRouter = new Hono<AppBindings>();

healthRouter.get("/", (c) => {
  const revision = c.env.PRISM_DEPLOY_REVISION;
  if (revision) {
    c.header("x-prism-revision", revision);
  }
  return c.json({
    ok: true,
    service: "prism-api",
    status: "healthy",
  });
});
