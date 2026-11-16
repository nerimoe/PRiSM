import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";

export const versionRouter = new Hono<AppBindings>();

/**
 * Which deployment is answering: the Worker's name and the commit it was built
 * from, both set by the deploy script. There is no release number. A process
 * nobody deployed, such as the local runtime, says `local` and `dev`.
 */
versionRouter.get("/", (c) =>
  c.json({
    worker: c.env.PRISM_WORKER_NAME ?? "local",
    revision: c.env.PRISM_DEPLOY_REVISION ?? "dev",
  }));
