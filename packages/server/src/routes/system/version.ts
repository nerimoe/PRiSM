import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";

export const versionRouter = new Hono<AppBindings>();

versionRouter.get("/", (c) => {
  const versionInfo = c.get("deps")?.versionInfo ?? {
    version: "1.0.0",
    revision: c.env.PRISM_DEPLOY_REVISION ?? "dev",
  };
  return c.json({
    service: "prism-api",
    ...versionInfo,
  });
});
