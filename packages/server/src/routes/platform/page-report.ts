/**
 * How scanned pages fare on players' own networks, reported by the pages. Whether
 * the shops need a better route to the platform is decided from this, since a
 * page's real network cannot be measured from anywhere else.
 *
 * A page may report after its ticket has expired, or a visit that failed to open
 * on the next one, so a report names only its resource. It is not worth an
 * account: nothing here identifies a player, and it can only add to these rows.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { clientIp, nowIso } from "../../http.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";

const ms = z.number().int().min(0).max(3_600_000);
const count = z.number().int().min(0).max(100_000);

const visit = z.object({
  id: z.string().uuid(),
  client: z.enum(["web", "clip"]),
  openMs: ms.nullable(),
  openFailed: z.boolean(),
  documentMs: ms.nullable(),
  documentConnectMs: ms.nullable(),
  apiConnectMs: ms.nullable(),
  reads: count,
  readFailures: count,
  readMs: z.number().int().min(0),
  readMaxMs: ms,
  actions: count,
  actionFailures: count,
  actionMs: z.number().int().min(0),
  actionMaxMs: ms,
  socketConnectMs: ms.nullable(),
  socketDrops: count,
});

const reportSchema = z.object({
  publicId: z.string().min(1).max(64),
  visits: z.array(visit).min(1).max(5),
});

export const pageReportRouter = new Hono<AppBindings>();

pageReportRouter.post("/report", async (c) => {
  await enforceRateLimits(c, [{ key: `page-report:${clientIp(c.req.raw)}`, limit: 30, windowSeconds: 60 }]);
  const body = reportSchema.parse(await c.req.json());
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE public_id=?").bind(body.publicId).first<{ shop_id: string }>();
  if (!machine) return c.json({ ok: true });
  const network = (c.req.raw as Request & { cf?: { asn?: number; asOrganization?: string; country?: string; colo?: string } }).cf;
  const at = nowIso();
  await c.env.DB.batch(body.visits.map((report) => c.env.DB.prepare(
    `INSERT INTO page_reports(id,reported_at,shop_id,client,asn,as_organization,country,colo,open_ms,open_failed,document_ms,document_connect_ms,api_connect_ms,
       reads,read_failures,read_ms,read_max_ms,actions,action_failures,action_ms,action_max_ms,socket_connect_ms,socket_drops)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET reported_at=excluded.reported_at,open_ms=excluded.open_ms,open_failed=excluded.open_failed,
       document_ms=excluded.document_ms,document_connect_ms=excluded.document_connect_ms,api_connect_ms=excluded.api_connect_ms,
       reads=excluded.reads,read_failures=excluded.read_failures,read_ms=excluded.read_ms,read_max_ms=excluded.read_max_ms,
       actions=excluded.actions,action_failures=excluded.action_failures,action_ms=excluded.action_ms,action_max_ms=excluded.action_max_ms,
       socket_connect_ms=excluded.socket_connect_ms,socket_drops=excluded.socket_drops`,
  ).bind(
    report.id, at, machine.shop_id, report.client,
    network?.asn ?? null, network?.asOrganization ?? null, network?.country ?? null, network?.colo ?? null,
    report.openMs, +report.openFailed, report.documentMs, report.documentConnectMs, report.apiConnectMs,
    report.reads, report.readFailures, report.readMs, report.readMaxMs,
    report.actions, report.actionFailures, report.actionMs, report.actionMaxMs,
    report.socketConnectMs, report.socketDrops,
  )));
  return c.json({ ok: true });
});
