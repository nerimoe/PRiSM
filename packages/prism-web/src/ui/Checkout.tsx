import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { playerOperation } from "../api";
import { useI18n } from "../i18n";
import { operationLocation, shopApi, type ShopInfo } from "./BillingPages";
import { BillTimeline, BillTotal, type BillPreview } from "./BillTimeline";

export type Receipt = Omit<BillPreview, "settlementPreview"> & { playerSettlement: { total: number; settledAt: string } };

export function SettledBill({ receipt }: { receipt: Receipt }) {
  const { t } = useI18n();
  const bill = { ...receipt, settlementPreview: receipt.playerSettlement };
  return <div className="grid gap-5">
    <div className="receipt-status"><span aria-hidden="true">✓</span><div><h2>{t("结账成功")}</h2><p>{new Date(receipt.playerSettlement.settledAt).toLocaleString()}</p></div></div>
    <BillTotal preview={bill} /><BillTimeline preview={bill} />
  </div>;
}

export function CheckoutButton({ info, onComplete, onPendingChange }: { info: ShopInfo; onComplete: (receipt: Receipt) => void; onPendingChange?: (pending: boolean) => void }) {
  const { t, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => complete.current(receipt), 1500);
    return () => clearTimeout(timer);
  }, [receipt]);
  async function checkout() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    onPendingChange?.(true);
    try {
      setReceipt(await playerOperation<Receipt>(shopApi(info.shop.publicId, "player/checkout/confirm"), {
        location: await operationLocation(info.shop.locationEnabled ?? info.shop.checkoutGeo),
      }));
    } catch (e) { locked.current = false; onPendingChange?.(false); setError(errorText(e instanceof Error ? e.message : "操作失败")); }
    finally { setBusy(false); }
  }
  return <>
    {error && <p role="alert" className="checkout-error">{error}</p>}
    <button ref={button} className="session-action bill-checkout w-full" disabled={busy || !!receipt} onClick={() => void checkout()}>
      {busy && <Loader2 size={20} className="animate-spin" />}{t("结账")}
    </button>
    {receipt && createPortal(<div className="checkout-success" role="status" aria-live="polite">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="43" /><path d="M28 51 L44 67 L73 35" /></svg>
      <h2>{t("结账成功")}</h2><p>{t("计费已结束，离店前无需再做其他操作。")}</p>
    </div>, button.current?.closest("dialog") ?? document.body)}
  </>;
}
