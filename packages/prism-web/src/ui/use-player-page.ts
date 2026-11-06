import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { operationLocation } from "./BillingPages";
import { pageReport } from "./page-report";
import {
  ACTION_RETRY, FRESH_READ_MS, openPageChannel, pageChannelUrl, READ_RETRY, RECHECK_MS, StillRunning, withRetries,
  type ActionAnswer, type Page,
} from "./player-page";

/**
 * The one way a scanned page gets its state: it reads the whole page, when it
 * opens, when told it changed, on coming back to the foreground, and every minute
 * while visible in case a push was lost. An action answers with the page too.
 */
export function usePlayerPage(ticket: string, onExpired: () => void) {
  const { user, setActiveShop, setBillingActive } = useAuth();
  const { locale } = useI18n();
  const [page, setPage] = useState<Page | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** An attempt failed and another is under way. */
  const [slow, setSlow] = useState(false);
  const live = useRef({ reading: false, again: false, stopped: false, answers: 0, readAt: 0, opened: false, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  /** Operation ids of what got no answer, so pressing again cannot do it twice. */
  const unanswered = useRef(new Map<string, string>());

  const read = useCallback(async (): Promise<void> => {
    const state = live.current;
    if (state.stopped) return;
    if (state.reading) {
      state.again = true;
      return;
    }
    state.reading = true;
    clearTimeout(state.timer);
    const answersBefore = state.answers;
    try {
      const current = await withRetries(
        (signal) => api<Page>(`/api/v1/devices/session/page?ticket=${encodeURIComponent(ticket)}`, { signal }),
        { ...READ_RETRY, onRetry: () => setSlow(true) },
      );
      if (state.stopped) return;
      state.readAt = Date.now();
      setSlow(false);
      setFailure(null);
      // An action answered meanwhile: its page is newer than this one.
      if (state.answers === answersBefore) setPage(current);
      if (!state.opened) {
        state.opened = true;
        pageReport.opened(current.publicId);
      }
    } catch (caught) {
      if (state.stopped) return;
      setSlow(false);
      if (caught instanceof ApiError && caught.sessionExpired) return onExpired();
      if (!state.opened) {
        pageReport.openFailed();
        setFailure(caught instanceof TypeError ? "网络连接失败，请检查网络后重试" : "这台机台暂时不可用，请稍后重试");
      }
      // A page already showing stays as it is; the next read tries again.
    } finally {
      state.reading = false;
      if (!state.stopped) {
        if (state.again) {
          state.again = false;
          void read();
        } else {
          state.timer = setTimeout(() => {
            if (document.visibilityState === "visible") void read();
            else state.readAt = 0;
          }, RECHECK_MS);
        }
      }
    }
  }, [ticket, onExpired]);

  /** Does what the page offered and shows the page it answers with. Throws only what the page cannot answer. */
  const act = useCallback(async (action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean): Promise<ActionAnswer> => {
    const location = await operationLocation(needsLocation);
    const key = `${action}:${JSON.stringify(payload ?? null)}`;
    const operationId = unanswered.current.get(key) ?? crypto.randomUUID();
    unanswered.current.set(key, operationId);
    try {
      const answer = await withRetries(
        async (signal) => {
          const result = await api<ActionAnswer>("/api/v1/devices/session/action", {
            method: "POST", signal, body: JSON.stringify({ ticket, operationId, action, payload, location }),
          });
          if (result.notices.some((notice) => notice.code === "OPERATION_PENDING")) throw new StillRunning();
          return result;
        },
        { ...ACTION_RETRY, onRetry: () => setSlow(true) },
      );
      unanswered.current.delete(key);
      live.current.answers += 1;
      live.current.readAt = Date.now();
      setPage(answer.page);
      return answer;
    } catch (caught) {
      if (caught instanceof ApiError) unanswered.current.delete(key);
      if (caught instanceof ApiError && caught.sessionExpired) onExpired();
      throw caught;
    } finally {
      setSlow(false);
    }
  }, [ticket, onExpired]);

  useEffect(() => {
    const state = live.current;
    state.stopped = false;
    pageReport.start();
    void read();
    return () => {
      state.stopped = true;
      clearTimeout(state.timer);
    };
  }, [read, locale]);

  // Signing in happens on this page, and changes everything on it.
  const askedToSignIn = !!page?.blocks.some((block) => block.kind === "signin");
  useEffect(() => {
    if (user && askedToSignIn) void read();
  }, [user, askedToSignIn, read]);

  const shopCode = page?.shopCode;
  const billingActive = page?.billingActive;
  useEffect(() => {
    if (!shopCode) return;
    setActiveShop(shopCode);
    setBillingActive(shopCode, !!billingActive);
  }, [shopCode, billingActive, setActiveShop, setBillingActive]);

  // Pushes need an account, so a stranger's page gets none until signed in.
  const connect = !!page && !askedToSignIn && typeof WebSocket !== "undefined";
  useEffect(() => {
    if (!connect) return;
    const channel = openPageChannel(pageChannelUrl(ticket, window.location.href), {
      onChanged: () => void read(),
      onOpen: (firstTime) => {
        if (!firstTime || Date.now() - live.current.readAt > FRESH_READ_MS) void read();
      },
    });
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      channel.wake();
      if (Date.now() - live.current.readAt > FRESH_READ_MS) void read();
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("pageshow", foreground);
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("pageshow", foreground);
      channel.close();
    };
  }, [connect, ticket, read]);

  return { page, failure, slow, read, act };
}
