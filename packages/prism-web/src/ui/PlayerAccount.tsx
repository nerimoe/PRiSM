import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Loader2, X } from "lucide-react";
import { allPageBlocks, type Page, type PageCelebration, type PageTarget } from "@prism/page-protocol";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi } from "./BillingPages";
import { mergeListBlocks } from "./page-blocks/merge-list";
import { useShopPageAct } from "./page-blocks/use-page-actions";
import { PlayerPageBlocks } from "./PlayerPageBlocks";

export function PlayerDialog({
  title,
  children,
  onClose,
  onBack,
  backLabel,
  dismissDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  dismissDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="player-dialog"
      onCancel={(event) => {
        if (dismissDisabled) event.preventDefault();
        else onClose();
      }}
      onClick={(e) => {
        if (!dismissDisabled && e.target === ref.current) onClose();
      }}
    >
      <div className="player-dialog-content">
        <header>
          {onBack && (
            <button
              type="button"
              className="player-dialog-back focus-ring p-2"
              onClick={onBack}
              disabled={dismissDisabled}
              aria-label={backLabel || t("返回")}
            >
              <ChevronLeft size={22} />
              {backLabel && <span>{backLabel}</span>}
            </button>
          )}
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="player-dialog-close focus-ring p-2"
            onClick={onClose}
            disabled={dismissDisabled}
            aria-label={t("关闭")}
          >
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function targetPath(shopCode: string, target: PageTarget): string {
  const params = new URLSearchParams({ view: target.view });
  if (target.item) params.set("item", target.item);
  if (target.cursor) params.set("cursor", target.cursor);
  return `${shopApi(shopCode, "player/page")}?${params.toString()}`;
}

export function AccountSheetPage({
  shopCode,
  initialView,
  onTitleChange,
  onBackChange,
  onRefreshHost,
  onCheckout,
  onCheckoutPending,
}: {
  shopCode: string;
  initialView: string;
  onTitleChange?: (title: string) => void;
  onBackChange?: (back: { label?: string; onBack: () => void } | null) => void;
  onRefreshHost?: () => void;
  onCheckout: () => void;
  onCheckoutPending: (pending: boolean) => void;
}) {
  const { t, errorText, locale } = useI18n();
  const { setBillingActive } = useAuth();
  /** Each level keeps the page it showed, so going back shows it as it was left (loaded pages, scroll). */
  const [stack, setStack] = useState<Array<{ target: PageTarget; kept?: { page: Page; scrollTop: number } }>>([
    { target: { view: initialView } },
  ]);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [loadingMoreId, setLoadingMoreId] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<{ blockId: string; message: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [celebration, setCelebration] = useState<PageCelebration | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const latestCheckout = useRef(onCheckout);
  latestCheckout.current = onCheckout;
  const latestTitleChange = useRef(onTitleChange);
  latestTitleChange.current = onTitleChange;
  const latestBackChange = useRef(onBackChange);
  latestBackChange.current = onBackChange;
  const latestRefreshHost = useRef(onRefreshHost);
  latestRefreshHost.current = onRefreshHost;

  const level = stack[stack.length - 1]!;
  const current = level.target;

  /** The level last shown from what it kept; reading again (retry, refresh) then fetches it anew. */
  const restored = useRef<{ level: typeof level; attempt: number } | null>(null);

  useEffect(() => {
    if (level.kept && restored.current?.level !== level) {
      restored.current = { level, attempt };
      const { page: kept, scrollTop } = level.kept;
      setPage(kept);
      setBusy(false);
      if (kept.title) latestTitleChange.current?.(kept.title);
      requestAnimationFrame(() => {
        const scroller = container.current?.querySelector(".account-scroll");
        if (scroller) scroller.scrollTop = scrollTop;
      });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    api<Page>(targetPath(shopCode, current), { signal: controller.signal })
      .then((loaded) => {
        if (cancelled) return;
        setPage(loaded);
        if (current.view === "bill") setBillingActive(shopCode, loaded.billingActive);
        if (loaded.title) latestTitleChange.current?.(loaded.title);
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted) return;
        if (e instanceof ApiError && e.notice?.flow === "refresh") {
          latestRefreshHost.current?.();
          return;
        }
        setError(errorText(e instanceof Error ? e.message : "操作失败"));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shopCode, level, current, attempt, locale, errorText, setBillingActive]);

  useEffect(() => {
    onCheckoutPending(actionBusy || celebration !== null);
  }, [actionBusy, celebration, onCheckoutPending]);

  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(() => latestCheckout.current(), 1500);
    return () => clearTimeout(timer);
  }, [celebration]);

  const act = useShopPageAct(shopCode, current.view, (answer) => {
    if (answer.ok && answer.celebration) return;
    setPage(answer.page);
    if (answer.ok && answer.page.title) latestTitleChange.current?.(answer.page.title);
    if (current.view === "bill") setBillingActive(shopCode, answer.page.billingActive);
    if (answer.ok && current.view === "redeem") {
      window.dispatchEvent(new CustomEvent("prism:shop-refresh"));
    }
  });

  const openTarget = (target: PageTarget) => {
    const scrollTop = container.current?.querySelector(".account-scroll")?.scrollTop ?? 0;
    const leaving = page;
    setError("");
    setLoadMoreError(null);
    setPage(null);
    setStack((prev) => [
      ...prev.slice(0, -1),
      { target: prev[prev.length - 1]!.target, ...(leaving ? { kept: { page: leaving, scrollTop } } : {}) },
      { target },
    ]);
  };

  const loadMore = async (blockId: string, target: PageTarget) => {
    if (loadingMoreId) return;
    setLoadingMoreId(blockId);
    setLoadMoreError(null);
    try {
      const next = await api<Page>(targetPath(shopCode, target));
      setPage((currentPage) => {
        if (!currentPage) return next;
        const incoming = allPageBlocks(next);
        return {
          ...currentPage,
          blocks: mergeListBlocks(currentPage.blocks, incoming, blockId),
          ...(currentPage.footer
            ? { footer: mergeListBlocks(currentPage.footer, incoming, blockId) }
            : {}),
        };
      });
    } catch (e) {
      setLoadMoreError({ blockId, message: errorText(e instanceof Error ? e.message : "操作失败") });
    } finally {
      setLoadingMoreId(null);
    }
  };

  useEffect(() => {
    if (stack.length > 1) {
      latestBackChange.current?.({
        ...(page?.backLabel ? { label: page.backLabel } : {}),
        onBack: () => {
          setError("");
          setLoadMoreError(null);
          setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
        },
      });
    } else {
      latestBackChange.current?.(null);
    }
  }, [stack.length, page?.backLabel]);

  useEffect(() => () => latestBackChange.current?.(null), []);

  const hasFooter = !!page?.footer?.length && !celebration;
  const prefix = (
    <>
      {error && (
        <div role="alert" className="text-sm text-coral">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setAttempt((v) => v + 1)}>
            {t("重试")}
          </button>
        </div>
      )}
      {busy && !page && <Loader2 className="mx-auto animate-spin" size={24} />}
    </>
  );

  return (
    <div ref={container} className={`account-content ${hasFooter ? "account-bill" : ""}`}>
      {page ? (
        <PlayerPageBlocks
          page={page}
          act={act}
          read={async () => setAttempt((v) => v + 1)}
          openTarget={openTarget}
          loadMore={loadMore}
          loadingMoreId={loadingMoreId}
          loadMoreError={loadMoreError}
          disabled={celebration !== null}
          onCelebrate={(next) => setCelebration(next)}
          onBusyChange={setActionBusy}
          bodyClassName="account-scroll"
          bodyPrefix={prefix}
          footerClassName="account-footer"
          wrapPasskey={false}
        />
      ) : (
        <div className="account-scroll">{prefix}</div>
      )}
      {celebration &&
        createPortal(
          <div className="checkout-success" role="status" aria-live="polite">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="43" />
              <path d="M28 51 L44 67 L73 35" />
            </svg>
            <h2>{celebration.title}</h2>
            <p>{celebration.subtitle}</p>
          </div>,
          container.current?.closest("dialog") ?? document.body,
        )}
    </div>
  );
}
