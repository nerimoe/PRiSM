import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { CreditCard, Plug, CheckCircle2 } from "lucide-react";
import { api, playerOperation } from "../../api";
import { browserHid, ReaderError, type BasicCard } from "../../card-reader";
import { HinataReaderManager } from "../../reader-manager";
import { useI18n } from "../../i18n";
import { shopApi } from "../BillingPages";
import { BillTotal, BillTimeline } from "../BillTimeline";
import { button, Field, input, money, primary, segment, useMerchant, type Preview } from "./shared";

type Profile = {
  id: string; displayName: string; status: string; kind: BasicCard["kind"]; uid: string;
  sessions: { id: string; startedAt: string; endedAt: string | null; status: string }[];
};
type CashierPreview = Preview & { settlementPreview: { total: number; previewedAt: string; sessionIds: string[] } };
type Scan = { card: BasicCard; profile: Profile | null };
export function Cashier({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const { shopCode, canWrite, timeZone } = useMerchant();
  const [params, setParams] = useSearchParams();
  const [scan, setScan] = useState<Scan | null>(null);
  const [preview, setPreview] = useState<CashierPreview | null>(null);
  const [readerName, setReaderName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readerError, setReaderError] = useState("");
  const [readerDetail, setReaderDetail] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<{ name: string; total: number; method: string } | null>(null);
  const reader = useRef<HinataReaderManager | null>(null);
  const readerConnected = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const working = useRef(false);
  const occupied = useRef(false);
  const mounted = useRef(true);
  const read = useCallback(<T,>(path: string, body?: unknown) => api<T>(shopApi(shopCode, `cashier/${path}`),
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), [shopCode]);
  const write = <T,>(path: string, body: Record<string, unknown> = {}) => playerOperation<T>(shopApi(shopCode, `cashier/${path}`), body);
  const loadProfile = useCallback(async (profile: Profile | null, card: BasicCard) => {
    setScan({ profile, card }); setPreview(null); setReceipt(null); setNotice("");
    if (profile?.sessions.length) setPreview(await read<CashierPreview>(`profiles/${segment(profile.id)}/checkout/preview`, {}));
  }, [read]);
  useEffect(() => {
    if (scan) panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scan, preview]);
  const handleCard = useRef<(card: BasicCard) => void>(() => {});
  handleCard.current = card => {
    if (working.current || occupied.current) {
      setNotice(t("请先完成当前玩家的操作，再移开卡片重新刷卡")); return;
    }
    occupied.current = true; working.current = true; setBusy(true); setError(""); setReceipt(null);
    let resolved = false;
    void read<{ profile: Profile | null }>("lookup", card)
      .then(result => { if (mounted.current) { resolved = true; return loadProfile(result.profile, card); } })
      .catch(e => { if (mounted.current) { setError(e.message); occupied.current = resolved; } })
      .finally(() => { working.current = false; if (mounted.current) setBusy(false); });
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const hid = browserHid();
    if (!hid || !canWrite) return;
    let active = true;
    const manager = new HinataReaderManager(hid, {
      onState: state => {
        if (!active) return;
        readerConnected.current = state.status === "connected";
        setReaderName(state.status === "connected" ? state.name : "");
        setConnecting(state.status === "connecting");
        if (state.status !== "disconnected") { setReaderError(""); setReaderDetail(""); }
      },
      onCard: card => { if (active) handleCard.current(card); },
      onError: error => {
        if (!active) return;
        setReaderError(readerConnected.current ? t("读卡器本次读取未完成，正在重试") : t(error.message));
        setReaderDetail(error instanceof ReaderError ? error.detail : "");
      },
      onRecovered: () => { if (active) { setReaderError(""); setReaderDetail(""); } },
    });
    reader.current = manager;
    void manager.start();
    return () => {
      active = false; readerConnected.current = false;
      if (reader.current === manager) reader.current = null;
      void manager.dispose();
    };
  }, [canWrite, t]);
  const playerId = params.get("cashierPlayer");
  useEffect(() => {
    if (!playerId || !canWrite) return;
    let current = true;
    let resolved = false;
    occupied.current = true; working.current = true; setBusy(true); setError("");
    void read<{ profile: Profile }>(`profiles/${segment(playerId)}`)
      .then(result => { if (current) { resolved = true; return loadProfile(result.profile, { kind: result.profile.kind, uid: result.profile.uid }); } })
      .catch(e => { if (current) { setError(e.message); occupied.current = resolved; } })
      .finally(() => { if (current) { working.current = false; setBusy(false); } });
    return () => { current = false; };
  }, [playerId, canWrite, read, loadProfile]);
  async function connect() {
    setConnecting(true); setReaderError(""); setReaderDetail("");
    try {
      if (!reader.current) throw new Error(t("此浏览器不支持 WebHID，请使用桌面版 Chrome 或 Edge"));
      await reader.current.requestDevice();
    } catch (e) { if (mounted.current) setReaderError((e as Error).message); }
    finally { if (mounted.current) setConnecting(false); }
  }
  async function act(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  function next() {
    occupied.current = false; setScan(null); setPreview(null); setNotice(""); setError("");
    if (playerId) setParams(previous => { const next = new URLSearchParams(previous); next.delete("cashierPlayer"); return next; });
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("displayName") ?? "");
    if (!scan) return;
    await act(async () => {
      const result = await write<{ profile: Profile }>("register", { card: scan.card, displayName: name });
      setScan({ ...scan, profile: result.profile });
      const entered = await write<{ profile: Profile }>(`profiles/${segment(result.profile.id)}/entry`);
      onChanged();
      next();
      setNotice(t("已入场，开始计时") + ` · ${entered.profile.displayName}`);
    });
  }
  async function collect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scan?.profile || !preview) return;
    const form = new FormData(event.currentTarget);
    await act(async () => {
      const result = await write<{ playerSettlement: { total: number } }>(`profiles/${segment(scan.profile!.id)}/checkout/confirm`, {
        collected: form.get("collected") === "on", method: form.get("method"),
        expectedTotal: preview.settlementPreview.total, previewedAt: preview.settlementPreview.previewedAt,
        sessionIds: preview.settlementPreview.sessionIds,
      });
      setReceipt({ name: scan.profile!.displayName, total: result.playerSettlement.total, method: String(form.get("method")) }); next();
      onChanged();
    });
  }
  if (!canWrite) return <p className="py-10 text-ink/60">{t("只读账号不能操作前台收银")}</p>;
  const at = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: timeZone || undefined });
  return <section ref={panel} className="grid scroll-mt-5 gap-5 rounded-xl border border-ink/10 p-4 sm:p-5" aria-label={t("前台收银")}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-lg font-semibold">{t("前台收银")}</h3><p className="mt-1 text-sm text-ink/60">{t("低安全模式 · 卡片仅用于计时，现场收款，不预存余额")}</p></div>
      {readerName ? <button className={button} onClick={() => { void reader.current?.disconnect(); setReaderError(""); setReaderDetail(""); }}>{t("断开读卡器")}</button>
        : <button className={primary} disabled={connecting} onClick={connect}><Plug size={18} />{t(connecting ? "连接中..." : "连接读卡器")}</button>}
    </header>
    {!browserHid() && <p className="rounded-xl bg-ink/5 p-4 text-sm">{t("此浏览器不支持 WebHID，请使用桌面版 Chrome 或 Edge")}</p>}
    <div className="flex items-center gap-3 rounded-xl border border-ink/10 bg-panel p-4" role="status">
      <CreditCard className={readerName ? "text-mint" : "text-ink/40"} size={24} />
      <div><p className="font-medium">{readerName || t("读卡器未连接")}</p><p className="text-sm text-ink/60">{t(busy ? "正在处理，请稍候" : scan ? "请完成当前玩家的操作" : "等待玩家刷卡")}</p></div>
    </div>
    {error && <p role="alert" className="text-coral">{error}</p>}
    {readerError && <div role="alert" className="text-coral"><p>{readerError}</p>{readerDetail && <details className="mt-2 text-sm"><summary className="cursor-pointer">{t("读卡器通信详情")}</summary><pre className="mt-2 whitespace-pre-wrap break-all font-mono">{readerDetail}</pre></details>}</div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {receipt && <section className="rounded-xl border border-mint/30 bg-mint/5 p-5" role="status"><h3 className="flex items-center gap-2 font-semibold"><CheckCircle2 size={20} />{t("已收款并结账")}</h3><p className="mt-2">{receipt.name} · {money(receipt.total)} · {t(({ wechat: "微信", alipay: "支付宝", cash: "现金", other: "其他" } as Record<string, string>)[receipt.method]!)}</p></section>}
    {scan && <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
      <header className="flex items-center justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="break-words text-lg font-semibold">{scan.profile?.displayName || t("新卡片")}</h3><p className="mt-1 break-all font-mono text-sm text-ink/60">{scan.card.kind === "felica" ? "IDm" : "UID"} · {scan.card.uid}</p></div><button className={button} disabled={busy} onClick={next}>{t("取消 / 下一位")}</button></header>
      {!scan.profile ? <form className="grid gap-4" onSubmit={register}><p className="text-sm text-ink/60">{t("请询问玩家昵称，创建店内计时档案")}</p><Field label="昵称"><input autoFocus required maxLength={80} name="displayName" className={input} /></Field><button className={primary} disabled={busy}>{t("登记并入场")}</button></form>
        : scan.profile.status !== "active" ? <p className="text-coral">{t("店铺玩家资格已停用")}</p>
        : !scan.profile.sessions.length ? <div className="grid gap-3"><p>{t("当前没有未结账计时")}</p><button className={primary} disabled={busy} onClick={() => act(async () => {
          await write(`profiles/${segment(scan.profile!.id)}/entry`); onChanged(); const name = scan.profile!.displayName; next(); setNotice(t("已入场，开始计时") + ` · ${name}`);
        })}>{t("确认入场")}</button></div>
        : <><div className="grid gap-2 text-sm">{scan.profile.sessions.map(session => <p key={session.id}>{t(session.status === "active" ? "计费中" : "待结账")} · {at(session.startedAt)}{session.endedAt && ` — ${at(session.endedAt)}`}</p>)}</div>
          {preview ? <form className="grid gap-4" onSubmit={collect}>
            <BillTotal preview={preview} /><BillTimeline preview={preview} />
            <p className="text-sm text-ink/60">{t("金额截止到本次账单预览时间；确认现场收款后结束计时")}</p>
            <p className="text-sm text-ink/60">{t("账单时间")} · {at(preview.settlementPreview.previewedAt)}</p>
            <Field label="收款方式"><select className={input} name="method"><option value="wechat">{t("微信")}</option><option value="alipay">{t("支付宝")}</option><option value="cash">{t("现金")}</option><option value="other">{t("其他")}</option></select></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="collected" required key={preview.settlementPreview.previewedAt} />{t("我已通过上述方式收到款项")}</label>
            <button className={primary} disabled={busy}>{t("确认已收款并结账")}</button>
          </form> : null}
          <button className={button} disabled={busy} onClick={() => act(async () => setPreview(await read<CashierPreview>(`profiles/${segment(scan.profile!.id)}/checkout/preview`, {})))}>{t("刷新账单")}</button>
        </>}
    </section>}
    <p className="text-xs text-ink/50">{t("卡片 UID 可被复制，请由店员核对玩家。此模式不存储资产，也不提供在线支付。")}</p>
  </section>;
}
