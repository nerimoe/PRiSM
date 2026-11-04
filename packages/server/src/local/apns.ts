import { connect, type ClientHttp2Session } from "node:http2";
import type { ApnsTransport } from "../durable-objects/live-activity-push.js";

/**
 * APNs over `node:http2`, one connection per origin kept open between pushes
 * as Apple asks; a closed or failed connection is opened again on the next push.
 */
const TIMEOUT_MS = 10_000;

export function http2ApnsTransport(): ApnsTransport {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string) => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const created = connect(origin);
    const forget = () => { if (sessions.get(origin) === created) sessions.delete(origin); };
    created.on("close", forget);
    created.on("error", forget);
    created.on("goaway", forget);
    sessions.set(origin, created);
    return created;
  };
  return ({ url, headers, body }) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const stream = session(target.origin).request({
      ":method": "POST",
      ":path": `${target.pathname}${target.search}`,
      ...headers,
    });
    let status = 0;
    let text = "";
    stream.setTimeout(TIMEOUT_MS, () => stream.close());
    stream.setEncoding("utf8");
    stream.on("response", (head) => { status = Number(head[":status"]); });
    stream.on("data", (chunk: string) => { text += chunk; });
    stream.on("end", () => status ? resolve({ status, body: text }) : reject(new Error("APNs closed the stream without a response")));
    stream.on("error", reject);
    stream.end(body);
  });
}
