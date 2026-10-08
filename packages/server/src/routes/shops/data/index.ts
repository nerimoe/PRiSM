import { Hono } from "hono";
import type { AppBindings } from "../../../bindings.js";
import type { AppBindings as DataBindings } from "./compat.js";
import { registerShopDataRoutes } from "./shop-data.js";
import { registerShopTransferAllowanceRoutes } from "./shop-data-export.js";

export const shopDataRouter = new Hono<AppBindings>();
registerShopDataRoutes(shopDataRouter as unknown as Hono<DataBindings>);

export const shopDataAdminRouter = new Hono<AppBindings>();
registerShopTransferAllowanceRoutes(shopDataAdminRouter as unknown as Hono<DataBindings>);
