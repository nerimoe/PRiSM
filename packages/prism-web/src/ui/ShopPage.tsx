import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { Page, PageCelebration } from "@prism/page-protocol";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi } from "./BillingPages";
import { PlayerPageBlocks } from "./PlayerPageBlocks";
import { useShopPageAct } from "./page-blocks/use-page-actions";
import type { ActionAnswer } from "./player-page";
import { ShopHero } from "./SessionContent";
import { isTransientReadFailure, usePagePolling } from "./use-page-polling";

export default function ShopPage() {
  const { shopCode = "" } = useParams();
  const { user } = useAuth();
  return <ShopSurface key={`${shopCode}:${user?.id ?? "guest"}`} shopCode={shopCode} />;
}

function ShopSurface({ shopCode }: { shopCode: string }) {
  const { t, errorText, locale } = useI18n();
  const { user, loading, setActiveShop, setBillingActive, setAccountMenu } = useAuth();
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pendingCelebration, setPendingCelebration] = useState<{
    celebration: PageCelebration;
    answer: ActionAnswer;
  } | null>(null);
  const actionPending = useRef(false);
  const actionRevision = useRef(0);
  const celebrating = useRef(false);
  celebrating.current = pendingCelebration !== null;

  const syncPageState = useCallback(
    (next: Page) => {
      setPage(next);
      setBillingActive(shopCode, next.billingActive);
      setAccountMenu(shopCode, next.accountMenu ?? null);
    },
    [shopCode, setBillingActive, setAccountMenu],
  );

  useEffect(() => {
    setActiveShop(shopCode);
    return () => setActiveShop("");
  }, [shopCode, setActiveShop]);

  useEffect(() => {
    const refreshShop = () => setAttempt((value) => value + 1);
    window.addEventListener("prism:shop-refresh", refreshShop);
    return () => window.removeEventListener("prism:shop-refresh", refreshShop);
  }, []);

  useEffect(() => {
    if (!pendingCelebration) return;
    const timer = setTimeout(() => {
      celebrating.current = false;
      actionRevision.current += 1;
      syncPageState(pendingCelebration.answer.page);
      setPendingCelebration(null);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pendingCelebration, syncPageState]);

  usePagePolling(
    async (signal) => {
      if (actionPending.current || celebrating.current) return;
      const revision = actionRevision.current;
      try {
        const current = await api<Page>(`${shopApi(shopCode, "player/page")}?view=shop`, { signal });
        if (signal.aborted || actionPending.current || celebrating.current || revision !== actionRevision.current) return;
        syncPageState(current);
        setError("");
      } catch (e) {
        if (!signal.aborted && (!page || !isTransientReadFailure(e))) {
          setError(errorText(e instanceof Error ? e.message : "操作失败"));
        }
        throw e;
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    !loading,
    `${shopCode}:${locale}:${attempt}`,
    !page || (!pendingCelebration && !!user && page.blocks.some((block) => block.kind === "binding")),
  );

  const act = useShopPageAct(
    shopCode,
    "shop",
    (answer) => {
      actionRevision.current += 1;
      if (!(answer.ok && answer.celebration)) syncPageState(answer.page);
    },
    {
      onBeforeAct: () => {
        actionRevision.current += 1;
      },
      onPendingChange: (pending) => {
        actionPending.current = pending;
      },
    },
  );

  const hasFooter = !!page?.footer?.length;

  return (
    <section className={`machine-session shop-session ${hasFooter ? "has-checkout" : ""}`}>
      {page && <ShopHero name={page.shop || shopCode} heroUrl={page.heroUrl} subtitle={page.resource} />}
      {error && (
        <div role="alert" className="text-coral">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setAttempt((value) => value + 1)}>
            {t("重试")}
          </button>
        </div>
      )}
      {loading || (busy && !page) ? (
        <Loader2 className="mx-auto animate-spin" />
      ) : (
        page && (
          <PlayerPageBlocks
            page={page}
            act={act}
            read={async () => setAttempt((value) => value + 1)}
            disabled={pendingCelebration !== null}
            bodyClassName="shop-controls"
            footerClassName="shop-checkout"
            onCelebrate={(celebration, answer) => {
              celebrating.current = true;
              actionRevision.current += 1;
              setPendingCelebration({ celebration, answer });
            }}
          />
        )
      )}
      {pendingCelebration &&
        createPortal(
          <div className="checkout-success" role="status" aria-live="polite">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="43" />
              <path d="M28 51 L44 67 L73 35" />
            </svg>
            <h2>{pendingCelebration.celebration.title}</h2>
            <p>{pendingCelebration.celebration.subtitle}</p>
          </div>,
          document.body,
        )}
    </section>
  );
}
