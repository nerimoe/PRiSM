import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { runPlayerOperation } from "./player-operation.js";
import { toStaffPricingExtensionView, toPlayerCheckoutResultView, toDeviceCommandView, toStaffDeviceCommandView, toDeviceStateView, toMachineConnectionView } from "./views.js";

/** Historical standalone route names that were not covered by /pricing-configs. */
export const staffPricingCompatRouter = new Hono<AppBindings>();

staffPricingCompatRouter.get("/pricing-extensions", async (c) => {
  await staffPrincipal(c, getShop(c), true);
  const commands = getShopDeps(c).staffPricingCommands as {
    listPricingExtensions?: () => Promise<any[]>;
  };
  const extensions = commands.listPricingExtensions
    ? await commands.listPricingExtensions()
    : [];
  return c.json({ pricingExtensions: extensions.map(toStaffPricingExtensionView) });
});

staffPricingCompatRouter.post("/pricing-timeline/preview", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole === "viewer") {
    jsonError(403, "Write permission required.", "FORBIDDEN");
  }
  const body = await c.req.json<any>();
  const localDate = body.localDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    jsonError(400, "Pricing timeline date must use YYYY-MM-DD.", "INVALID_TIMELINE_DATE");
  }
  const timeline = await getShopDeps(c).staffPricingCommands.previewPricingTimeline({
    localDate,
    displayTimeZone: body.displayTimeZone ?? shop.time_zone,
    provider: body.provider,
  });
  return c.json({ timeline });
});

/** Keep the full pre-fork standalone staff command and monitoring surface. */
staffPricingCompatRouter.post("/sessions/active/checkout",async c=>{
  const principal=await staffPrincipal(c,getShop(c));
  if(principal.staffRole==="viewer")jsonError(403,"只读员工不能执行结账","FORBIDDEN");
  const body=await c.req.json<Record<string,unknown>>().catch(()=>({}));
  return runPlayerOperation(c,getShop(c).id,"staff/sessions/active/checkout",body,async()=>{
    const settled=await getShopDeps(c).staffOperations.checkoutAllActivePlayers();
    return c.json({settlements:settled.map(toPlayerCheckoutResultView)});
  });
});

staffPricingCompatRouter.post("/device-actions",async c=>{
  const principal=await staffPrincipal(c,getShop(c));
  if(principal.staffRole==="viewer")jsonError(403,"只读员工不能操作设备","FORBIDDEN");
  const body=z.object({
    operationId:z.string().uuid(),
    type:z.string().min(1),
    target:z.record(z.string(),z.unknown()),
    payload:z.record(z.string(),z.unknown()).optional(),
  }).parse(await c.req.json());
  return runPlayerOperation(c,getShop(c).id,"staff/device-actions",body,async()=>{
    const command=await getShopDeps(c).deviceActions.requestDeviceAction({
      actor:{type:"staff",staffId:principal.staffId},
      type:body.type as any,
      target:body.target as any,
      payload:body.payload,
    });
    return c.json({action:toDeviceCommandView(command)});
  });
});

staffPricingCompatRouter.get("/device-commands",async c=>{
  await staffPrincipal(c,getShop(c),true);
  const list=getShopDeps(c).staffQueries.listDeviceCommands;
  if(!list)jsonError(503,"设备操作记录查询尚未配置","DEVICE_COMMANDS_NOT_CONFIGURED");
  const requested=Number.parseInt(c.req.query("limit")??"50",10);
  const limit=Number.isFinite(requested)&&requested>0?Math.min(200,requested):50;
  const commands=await list({limit});
  return c.json({commands:commands.map(toStaffDeviceCommandView)});
});

staffPricingCompatRouter.get("/device-states",async c=>{
  await staffPrincipal(c,getShop(c),true);
  const list=getShopDeps(c).staffQueries.listDeviceStates;
  if(!list)jsonError(503,"设备状态查询尚未配置","DEVICE_STATES_NOT_CONFIGURED");
  const states=await list();
  return c.json({deviceStates:states.map(toDeviceStateView)});
});

staffPricingCompatRouter.get("/machine-connections",async c=>{
  await staffPrincipal(c,getShop(c),true);
  const list=getShopDeps(c).staffQueries.listMachineConnections;
  if(!list)jsonError(503,"机台连接查询尚未配置","MACHINE_CONNECTIONS_NOT_CONFIGURED");
  const connections=await list();
  return c.json({machineConnections:connections.map(toMachineConnectionView)});
});
