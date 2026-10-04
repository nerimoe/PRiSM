import { useEffect, useRef } from "react";
import { PagePolling } from "./page-polling";
import { ApiError } from "../api";

export function isTransientReadFailure(error: unknown) {
  return error instanceof TypeError || error instanceof ApiError
    && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export function usePagePolling(read: (signal: AbortSignal) => Promise<void>, enabled = true, key = "", shouldPoll = true) {
  const latest = useRef(read);
  latest.current = read;
  const pollingNeeded = useRef(shouldPoll);
  pollingNeeded.current = shouldPoll;
  useEffect(() => {
    if (!enabled) return;
    const polling = new PagePolling(signal => latest.current(signal), 3000, () => pollingNeeded.current);
    const visibility = () => polling.setVisible(!document.hidden);
    const foreground = () => { if (!document.hidden) polling.refresh(); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", foreground);
    window.addEventListener("pageshow", foreground);
    return () => {
      polling.stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("pageshow", foreground);
    };
  }, [enabled, key]);
}
