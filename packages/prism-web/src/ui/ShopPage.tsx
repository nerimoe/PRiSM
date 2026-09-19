import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { post, shopApi, type ShopInfo, type Summary, type Preview } from "./BillingPages";
import { ShopHero, SessionSignIn, QQBinding } from "./SessionContent";
import { BillTotal, BillTimeline } from "./BillTimeline";
import { CheckoutButton, SettledBill, type Receipt } from "./Checkout";

export default function ShopPage() {
  const { shopCode = "" } = useParams();
  const { user } = useAuth();
  return <ShopSurface key={`${shopCode}:${user?.id ?? "guest"}`} shopCode={shopCode} />;
}

function ShopSurface({ shopCode }: { shopCode: string }) {
  const { t, errorText } = useI18n();
  const { user, loading, setActiveShop, setBillingActive } = useAuth();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [bill, setBill] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const checkoutPending = useRef(false);
  useEffect(() => { setActiveShop(shopCode); }, [shopCode, setActiveShop]);
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setError("");
      try {
        const shop = await api<ShopInfo>(shopApi(shopCode));
        if (cancelled) return;
        setInfo(shop);
        const current = user && shop.shop.billingEnabled && shop.membership
          ? await api<Summary>(shopApi(shopCode, "player/me")) : null;
        const preview = current?.activeSession ? await api<Preview>(shopApi(shopCode, "player/checkout/preview"), post()) : null;
        const latest = current && !current.activeSession ? await api<{ receipt: Receipt | null }>(shopApi(shopCode, "player/checkout/latest")) : null;
        if (cancelled || checkoutPending.current) return;
        setBill(preview); setReceipt(latest?.receipt ?? null);
        setBillingActive(shopCode, !!current?.activeSession);
        if (user && shop.shop.billingEnabled && !shop.membership) timer = setTimeout(load, 3000);
      } catch (e) { if (!cancelled) setError(errorText(e instanceof Error ? e.message : "操作失败")); }
      finally { if (!cancelled) setBusy(false); }
    }
    setBusy(true); void load();
    const refresh = () => { if (!document.hidden && !checkoutPending.current) { clearTimeout(timer); setAttempt(value => value + 1); } };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [shopCode, user, loading, attempt, errorText, setBillingActive]);
  return <section className={`machine-session shop-session ${bill ? "has-checkout" : ""}`}>
    {info && <ShopHero name={info.shop.name || shopCode} heroUrl={info.shop.heroUrl} subtitle={!user ? "" : bill ? t("计费中") : receipt ? t("结账成功") : busy ? t("正在加载") : t("未入场")} />}
    {error && <div role="alert" className="text-coral">{error}<button className="ml-3 underline" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>}
    {loading || (busy && !info) ? <Loader2 className="mx-auto animate-spin" /> : info && !user ? <SessionSignIn next={`/t/${encodeURIComponent(shopCode)}`} /> : busy && !bill && !receipt ? <Loader2 className="mx-auto animate-spin" /> : info && user && <>
      {!info.shop.billingEnabled ? <p className="session-subtitle">{t("本店未启用入场计费，暂无账单功能。")}</p>
        : !info.membership ? <QQBinding code={shopCode} />
        : bill ? <div className="grid gap-5"><BillTotal preview={bill} /><BillTimeline preview={bill} /></div>
        : receipt ? <SettledBill receipt={receipt} />
        : !error && <p className="session-subtitle">{t("请碰一下 NFC 或扫描机台上的二维码入场")}</p>}
      {bill && <footer className="shop-checkout"><CheckoutButton info={info} onPendingChange={pending => { checkoutPending.current = pending; }} onComplete={result => { checkoutPending.current = false; setReceipt(result); setBill(null); setBillingActive(shopCode, false); }} /></footer>}
    </>}
  </section>;
}
