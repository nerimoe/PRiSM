/**
 * Public WebSocket paths for direct-connected edge nodes.
 *
 * - `/node/ws`: unified entry for all node kinds (`hinata_io`, `launcher`, `iot`).
 * - `/io/ws`: legacy alias kept for deployed HINATA IO clients whose INI files
 *   point `[aimeio] serverUrl` at `/io/ws`.
 *
 * Neither path carries a shop or node identifier in the URL: the Bearer token
 * resolves the node and its Durable Object channel.
 */
export const machineRelayPath = "/io/ws";
export const nodeRelayPath = "/node/ws";

export function isRelayPath(pathname: string): boolean {
  return pathname === machineRelayPath || pathname === nodeRelayPath;
}
