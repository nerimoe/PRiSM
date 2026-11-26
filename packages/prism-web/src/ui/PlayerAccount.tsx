import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Loader2, X } from "lucide-react";
import type { Page, PageBlock, PageCelebration, PageTarget } from "@prism/page-protocol";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi } from "./BillingPages";
import { PlayerPageBlocks } from "./PlayerPageBlocks";
import { useShopPageAct } from "./page-blocks/use-page-actions";

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

function mergeListBlock(current: PageBlock[], incoming: PageBlock[], blockId: string): PageBlock[] {
  const replacement = incoming.find((block) => block.kind === "list" && block.id === blockId);
  if (!replacement || replacement.kind !== "list") return current;
  return current.map((block) => {
    if (block.kind !== "list" || block.id !== blockId) return block;
    const seen = new Set(block.items.map((item) => item.id));
    return {
      ...replacement,
      items: [...block.items, ...replacement.items.filter((item) => !seen.has(item.id))],
    };
  });
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
  onCheckout,
  onCheckoutPending,
}: {
  shopCode: string;
  initialView: string;
  onTitleChange?: (title: string) => void;
  onBackChange?: (back: { label?: string; onBack: () => void } | null) => void;
  onCheckout: () => void;
  onCheckoutPending: (pending: boolean) => void;
}) {
  const { t, errorText, locale } = useI18n();
  const { setBillingActive } = useAuth();
  const [stack, setStack] = useState<PageTarget[]>([{ view: initialView }]);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [loadingMoreId, setLoadingMoreId] = useState<string | null>(null);
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

  const current = stack[stack.length - 1]!;

  useEffect(() => {
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
        if (!cancelled && !controller.signal.aborted) {
          setError(errorText(e instanceof Error ? e.message : "操作失败"));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shopCode, current, attempt, locale, errorText, setBillingActive]);

  useEffect(() => {
    onCheckoutPending(actionBusy || celebration !== null);
  }, [actionBusy, celebration, onCheckoutPending]);

  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(() => latestCheckout.current(), 1500);
    return () => clearTimeout(timer);
  }, [celebration]);

  const act = useShopPageAct(shopCode, current.view, (answer) => {
    setPage(answer.page);
    if (answer.ok && answer.page.title) latestTitleChange.current?.(answer.page.title);
    if (current.view === "bill") setBillingActive(shopCode, answer.page.billingActive);
    if (answer.ok && answer.celebration === undefined && current.view === "redeem") {
      window.dispatchEvent(new CustomEvent("prism:shop-refresh"));
    }
  });

  const openTarget = (target: PageTarget) => {
    setError("");
    setPage(null);
    setStack((prev) => [...prev, target]);
  };

  const loadMore = async (blockId: string, target: PageTarget) => {
    if (loadingMoreId) return;
    setLoadingMoreId(blockId);
    setError("");
    try {
      const next = await api<Page>(targetPath(shopCode, target));
      setPage((currentPage) =>
        currentPage ? { ...currentPage, blocks: mergeListBlock(currentPage.blocks, next.blocks, blockId) } : next,
      );
    } catch (e) {
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
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
          setPage(null);
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
