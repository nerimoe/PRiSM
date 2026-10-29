import { useEffect, useRef, useState } from "react";
import type { ClimateState } from "./ClimateControls";

/**
 * What a device page is told of its device's power and air conditioner. A key
 * that is absent was not said; `null` is a value the backend could not read.
 * Where a value came from (stored events or Home Assistant asked now) is the
 * backend's business: the page shows the latest it was told.
 */
export type DeviceView = { power?: "on" | "off" | null; climate?: ClimateState | null };

/** A frame the shop hub pushes to a device page. */
export type LiveFrame =
  /** The device's state; `hello` is the first one on a connection. */
  | ({ type: "hello" | "state" } & DeviceView)
  | { type: "refresh"; reason?: string };

const powerOf = (value: unknown): "on" | "off" | null => (value === "on" || value === "off" ? value : null);

/** The power and climate a frame or a response carries; other keys are ignored. */
export function deviceViewOf(value: unknown): DeviceView {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...("power" in record ? { power: powerOf(record.power) } : {}),
    ...("climate" in record ? { climate: (record.climate as ClimateState | null) ?? null } : {}),
  };
}

/**
 * A frame from the hub, or null for anything that is not one. `watching`
 * frames are state like any other; the flag itself is for older App Clips.
 */
export function parseLiveFrame(raw: string): LiveFrame | null {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  if (frame.type === "hello") return { type: "hello", ...deviceViewOf(frame) };
  if (frame.type === "state" || frame.type === "watching") return { type: "state", ...deviceViewOf(frame) };
  if (frame.type === "refresh") return { type: "refresh", ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}) };
  return null;
}

export type LiveStatus = {
  /** The hub has greeted this connection, so what it says is current. */
  connected: boolean;
  /** A connection that had been up closed since; what it last said may be out of date. */
  dropped: boolean;
};

export type LiveHandlers = {
  /** The device's state, whenever the hub says anything about it. */
  onState(view: DeviceView): void;
  /** Something the page shows changed elsewhere (a bot confirmed the binding); read it again. */
  onRefresh(): void;
};

export const idleLive: LiveStatus = { connected: false, dropped: false };

/** What a frame does to the connection's status, and what the page is told. */
export function applyLiveFrame(status: LiveStatus, frame: LiveFrame, handlers: LiveHandlers): LiveStatus {
  if (frame.type === "refresh") {
    handlers.onRefresh();
    return status;
  }
  const { type, ...view } = frame;
  if (Object.keys(view).length) handlers.onState(view);
  return type === "hello" ? { connected: true, dropped: false } : status;
}

const RETRY_MS = [5000, 10_000, 20_000, 60_000];

/**
 * The shop hub's channel for a device page: its device's state, sent when the
 * connection opens and whenever the backend learns something new, and word when
 * the page's own state changed. A dropped connection is reopened with a growing
 * wait; meanwhile `dropped` tells the page its last state may be stale.
 */
export function useResourceLive(ticket: string, enabled: boolean, handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(idleLive);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let failures = 0;
    let current = idleLive;
    const set = (next: LiveStatus) => {
      current = next;
      setStatus(next);
    };
    const connect = () => {
      const url = new URL(`/api/v1/devices/session/ws?ticket=${encodeURIComponent(ticket)}`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const opened = new WebSocket(url);
      socket = opened;
      opened.onmessage = (event) => {
        const frame = parseLiveFrame(String(event.data));
        if (!frame) return;
        if (frame.type === "hello") failures = 0;
        set(applyLiveFrame(current, frame, latest.current));
      };
      opened.onclose = () => {
        if (socket !== opened) return;
        set({ connected: false, dropped: current.connected || current.dropped });
        if (!stopped) retry = setTimeout(connect, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      const closing = socket;
      socket = null;
      closing?.close();
      setStatus(idleLive);
    };
  }, [ticket, enabled]);
  return status;
}
