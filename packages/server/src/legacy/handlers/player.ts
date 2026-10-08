import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { playerRouter } from "../../routes/shops/player.js";

export const legacyPlayerRouter = new Hono<AppBindings>();

// Mount the canonical player router for all legacy player endpoints
legacyPlayerRouter.route("/", playerRouter);

