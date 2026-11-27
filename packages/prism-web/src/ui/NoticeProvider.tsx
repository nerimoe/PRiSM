import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, InlineError, type Notice } from "../api";
import { useI18n } from "../i18n";
import { InlineNoticeLine, noticeDuration } from "./page-blocks/notices";
import { PlayerDialog } from "./PlayerAccount";

/** What a caller can do for the flows a notice may ask for. */
export type NoticeHandlers = {
  onExpired?: (notice?: Notice) => void;
  onRefresh?: () => void;
  retry?: () => void;
  /** A read the player did not ask for (polling, a reload after an action): run the flow, never open a dialog. */
  quiet?: boolean;
  onControl?: boolean;
};

type Show = (error: unknown, handlers?: NoticeHandlers) => Notice;

const NoticeContext = createContext<{ show: Show; preload: (templates: Record<string, Notice>) => void } | null>(null);

/**
 * The one place player-facing problems are presented. The server decides how
 * each one is shown; this runs its flow and shows the dialogs. An inline notice
 * is returned to the caller to show next to what the player touched.
 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const { t, errorText } = useI18n();
  const [open, setOpen] = useState<{ notice: Notice; retry?: () => void; refresh?: () => void } | null>(null);
  const templates = useRef<Record<string, Notice>>({});
  const preload = useCallback((next: Record<string, Notice>) => { templates.current = next; }, []);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), noticeDuration(toast) ?? 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const show = useCallback<Show>((error, handlers = {}) => {
    const localCode = error instanceof ApiError || error instanceof InlineError ? error.code
      : error instanceof TypeError ? "CLIENT_NETWORK_ERROR" : "CLIENT_OPERATION_FAILED";
    const cached = templates.current[localCode ?? "CLIENT_OPERATION_FAILED"];
    const notice: Notice = error instanceof ApiError && error.notice
      ? error.notice
      : isNotice(error)
        ? error
        : cached ?? {
            // Problems found on this device (no location, no network) have no server notice.
            code: "CLIENT",
            level: "error",
            display: "inline",
            presentation: "toast",
            flow: error instanceof ApiError && error.sessionExpired ? "expired" : "none",
            title: null,
            body: errorText(error),
            actions: [{ kind: "dismiss", label: t("知道了") }],
          };
    if (notice.flow === "expired") handlers.onExpired?.(notice);
    else if (notice.flow === "refresh") handlers.onRefresh?.();
    else if (notice.flow === "signin") window.location.reload();
    if (!handlers.quiet) {
      if (notice.display === "dialog") {
        setToast(null);
        setOpen({ notice, retry: handlers.retry, refresh: handlers.onRefresh });
      } else if (notice.display === "inline" && notice.presentation === "toast" && !handlers.onControl) setToast(notice);
    }
    return notice;
  }, [errorText, t]);
  const close = () => setOpen(null);
  return (
    <NoticeContext.Provider value={{ show, preload }}>
      {children}
      {toast && <div className="player-toast"
        onPointerDown={(event) => {
          swipeStart.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = swipeStart.current;
          if (start) event.currentTarget.style.transform = `translateX(-50%) translate(${event.clientX - start.x}px, ${Math.min(0, event.clientY - start.y)}px)`;
        }}
        onPointerUp={(event) => {
          event.currentTarget.style.transform = "";
          const start = swipeStart.current;
          swipeStart.current = null;
          if (start && (Math.abs(event.clientX - start.x) > 60 || event.clientY - start.y < -20)) setToast(null);
        }}
        onPointerCancel={(event) => { swipeStart.current = null; event.currentTarget.style.transform = ""; }}
        onKeyDown={(event) => { if (event.key === "Escape") setToast(null); }}
        tabIndex={0}
      ><InlineNoticeLine note={toast} /></div>}
      {open && (
        <PlayerDialog title={open.notice.title ?? t("操作失败")} onClose={close}>
          <p className="text-sm leading-relaxed">{open.notice.body}</p>
          <div className="mt-5 flex justify-end gap-2">
            {open.notice.actions
              .filter((action) => action.kind !== "settings" && (action.kind !== "retry" || open.retry) && (action.kind !== "refresh" || open.refresh))
              .map((action) => (
                <button
                  key={action.kind}
                  className={`session-action ${action.kind === "retry" ? "primary" : ""}`}
                  onClick={() => {
                    close();
                    if (action.kind === "retry") open.retry?.();
                    if (action.kind === "refresh") open.refresh?.();
                  }}
                >
                  {action.label}
                </button>
              ))}
          </div>
        </PlayerDialog>
      )}
    </NoticeContext.Provider>
  );
}

function isNotice(value: unknown): value is Notice {
  return !!value && typeof value === "object" && "display" in value && "body" in value && "level" in value;
}

export function useNotice(): Show {
  const show = useContext(NoticeContext);
  if (!show) throw new Error("useNotice must be used inside NoticeProvider");
  return show.show;
}

/** Cache only server-authored templates, so action failures can still be explained offline. */
export function useNoticeTemplates(templates: Record<string, Notice> | undefined) {
  const context = useContext(NoticeContext);
  useEffect(() => { if (templates) context?.preload(templates); }, [context?.preload, templates]);
}

/**
 * A notice kept next to a control. News fades by itself; an error stays until
 * it is replaced or cleared (see `noticeLasts`).
 */
export function useInlineNotice() {
  const [note, setNote] = useState<Notice | null>(null);
  const timer = useMemo(() => ({ id: 0 as ReturnType<typeof setTimeout> | 0 }), []);
  const showNote = useCallback((next: Notice | null, onControl = false) => {
    if (timer.id) clearTimeout(timer.id);
    timer.id = 0;
    setNote(next);
    const lasts = next && noticeDuration(next, onControl);
    if (lasts) timer.id = setTimeout(() => setNote(null), lasts);
  }, [timer]);
  return [note, showNote] as const;
}
