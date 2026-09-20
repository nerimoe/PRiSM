import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, ReceiptText } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { shopApi } from "./BillingPages";
import { SettledBill, type Receipt } from "./Checkout";

type Record = { id: string; total: number; settledAt: string; startedAt: string | null; endedAt: string | null; sessionCount: number };
type History = { records: Record[]; nextOffset: number | null };

export function CheckoutHistory({ code }: { code: string }) {
  const { t, errorText } = useI18n();
  const [records, setRecords] = useState<Record[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState<Record | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError(""); setReceipt(null);
    async function load() {
      try {
        if (selected) {
          const result = await api<{ receipt: Receipt }>(shopApi(code, `player/checkouts/${encodeURIComponent(selected.id)}`));
          if (!cancelled) setReceipt(result.receipt);
        } else {
          const result = await api<History>(shopApi(code, `player/checkouts/history?offset=${offset}`));
          if (!cancelled) {
            setRecords(current => offset === 0 ? result.records : [...current.filter(row => !result.records.some(item => item.id === row.id)), ...result.records]);
            setNextOffset(result.nextOffset);
          }
        }
      } catch (e) { if (!cancelled) setError(errorText(e instanceof Error ? e.message : "操作失败")); }
      finally { if (!cancelled) setBusy(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [code, offset, selected, attempt, errorText]);
  return <div className="account-content"><div className="account-scroll checkout-history" key={selected?.id ?? "list"}>
    {selected ? <>
      <button className="history-back focus-ring" onClick={() => { setSelected(null); setReceipt(null); }}><ArrowLeft size={18} />{t("全部记录")}</button>
      {receipt && <>
        <SettledBill receipt={receipt} />
      </>}
    </> : <>
      {records.map(row => <button className="history-record focus-ring" key={row.id} onClick={() => { setReceipt(null); setBusy(true); setSelected(row); }}>
        <span className="history-icon"><ReceiptText size={21} /></span>
        <span className="history-label"><strong>{new Date(row.settledAt).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong><small>{t("已结账")}{row.sessionCount > 0 && ` · ${t("{count} 项计费", { count: row.sessionCount })}`}</small></span>
        <span className="history-amount"><small>{t("结账金额")}</small><strong>{row.total.toFixed(2)}</strong></span><ChevronRight size={16} />
      </button>)}
      {!busy && !error && !records.length && <div className="history-empty"><ReceiptText size={36} /><p>{t("暂无结账记录")}</p></div>}
    </>}
    {busy && <Loader2 className="mx-auto animate-spin" aria-label={t("正在加载")} />}
    {error && <div role="alert">{error}<button className="ml-3 underline" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>}
    {!selected && nextOffset != null && !busy && !error && <button className="session-action" onClick={() => setOffset(nextOffset)}>{t("加载更多")}</button>}
  </div></div>;
}
