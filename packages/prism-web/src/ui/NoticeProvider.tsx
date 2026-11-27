import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, type Notice } from "../api";
import { useI18n } from "../i18n";
import { InlineNoticeLine, noticeLasts } from "./page-blocks/notices";
import { PlayerDialog } from "./PlayerAccount";

/** What a caller can do for the flows a notice may ask for. */
export type NoticeHandlers = {
  onExpired?: () => void;
  onRefresh?: () => void;
  retry?: () => void;
  /** A read the player did not ask for (polling, a reload after an action): run the flow, never open a dialog. */
  quiet?: boolean;
  onControl?: boolean;
};

type Show = (error: unknown, handlers?: NoticeHandlers) => Notice;

const NoticeContext = createContext<Show | null>(null);

/**
 * The one place player-facing problems are presented. The server decides how
 * each one is shown; this runs its flow and shows the dialogs. An inline notice
 * is returned to the caller to show next to what the player touched.
 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const { t, errorText } = useI18n();
  const [open, setOpen] = useState<{ notice: Notice; retry?: () => void } | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), noticeLasts(toast.level, true) ?? 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const show = useCallback<Show>((error, handlers = {}) => {
    const notice: Notice = error instanceof ApiError && error.notice
      ? error.notice
      : isNotice(error)
        ? error
        : {
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
    if (notice.flow === "expired") handlers.onExpired?.();
    else if (notice.flow === "refresh") handlers.onRefresh?.();
    else if (notice.flow === "signin") window.location.reload();
    if (!handlers.quiet) {
      if (notice.display === "dialog") {
        setToast(null);
        setOpen({ notice, retry: handlers.retry });
      } else if (notice.display === "inline" && notice.presentation === "toast" && !handlers.onControl) setToast(notice);
    }
    return notice;
  }, [errorText, t]);
  const close = () => setOpen(null);
  return (
    <NoticeContext.Provider value={show}>
      {children}
      {toast && <div className="player-toast"><InlineNoticeLine note={toast} /></div>}
      {open && (
        <PlayerDialog title={open.notice.title ?? t("操作失败")} onClose={close}>
          <p className="text-sm leading-relaxed">{open.notice.body}</p>
          <div className="mt-5 flex justify-end gap-2">
            {open.notice.actions
              .filter((action) => action.kind !== "retry" || open.retry)
              .map((action) => (
                <button
                  key={action.kind}
                  className={`session-action ${action.kind === "retry" ? "primary" : ""}`}
                  onClick={() => {
                    close();
                    if (action.kind === "retry") open.retry?.();
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
  return show;
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
    const persistent = !onControl && (next?.presentation === "status" || next?.presentation === "field");
    const lasts = next && !persistent ? noticeLasts(next.level, onControl || next.presentation === "toast") : null;
    if (lasts) timer.id = setTimeout(() => setNote(null), lasts);
  }, [timer]);
  return [note, showNote] as const;
}
