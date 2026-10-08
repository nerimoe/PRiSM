import { Hono } from "hono";
import type { AppBindings } from "../../../bindings.js";
import { registerShopDataRoutes } from "./shop-data.js";
import { registerShopTransferAllowanceRoutes } from "./shop-data-export.js";

export const shopDataRouter = new Hono<AppBindings>();
registerShopDataRoutes(shopDataRouter);

export const shopDataAdminRouter = new Hono<AppBindings>();
registerShopTransferAllowanceRoutes(shopDataAdminRouter);
