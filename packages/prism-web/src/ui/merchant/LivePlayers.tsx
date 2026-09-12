import { useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { ActionForm, Modal, button, input, money, primary, segment, useMerchant, useStaffApi, type LivePlayer, type Preview } from "./shared";
import { liveBilling, stayDuration } from "./live-billing";

export function LivePlayers({ players, refresh, onManage }: {
  players: LivePlayer[]; refresh: () => void; onManage: (id: string) => void;
}) {
  const { t } = useI18n();
  const { timeZone, canWrite } = useMerchant();
  const request = useStaffApi();
  const billPanel = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [groupBy, setGroupBy] = useState("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkout, setCheckout] = useState<{ player: LivePlayer; preview: Preview } | null>(null);
  const [stop, setStop] = useState<{ playerId: string; session: LivePlayer["sessions"][number] } | null>(null);
  const selected = players.find(p => p.playerId === selectedId) ?? players[0];
  const groups = new Map<string, { label: string; players: LivePlayer[] }>();
  for (const player of players) {
    const bill = liveBilling(player);
    const key = groupBy === "none" ? "" : groupBy === "status" ? bill.status : bill.planKey;
    const label = groupBy === "status" ? t(bill.status) : bill.plans.join(" + ") || t("无进行中计费方案");
    const group = groups.get(key) ?? { label, players: [] };
    group.players.push(player);
    groups.set(key, group);
  }
  const at = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone || undefined, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value));
  const clockAt = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone || undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value));
  const dayAt = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone || undefined, month: "2-digit", day: "2-digit",
  }).format(new Date(value));
  const title = (session: LivePlayer["sessions"][number]) => !session.label || session.label === "entry" ? t("入场") : session.label;
  async function previewCheckout() {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const preview = await request<Preview>(`players/${segment(selected.playerId)}/checkout/preview`, "POST", {});
      setCheckout({ player: selected, preview });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <select className={`${input} !w-auto justify-self-start`} aria-label={t("玩家分组")} value={groupBy} onChange={e => setGroupBy(e.target.value)}>
      <option value="none">{t("不分组")}</option><option value="status">{t("按状态分组")}</option><option value="plan">{t("按计费方案分组")}</option>
    </select>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-ink/10 bg-panel">
        {[...groups].map(([key, group]) => <div key={key}>
          {groupBy !== "none" && <h3 className="border-b border-ink/10 bg-ink/[0.025] px-4 py-2 text-xs font-semibold">{group.label}<span className="ml-2 text-ink/50">{group.players.length}</span></h3>}
          {group.players.map(player => <button key={player.playerId} aria-pressed={selected?.playerId === player.playerId}
            onClick={() => { setSelectedId(player.playerId); if (window.innerWidth < 1280) billPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            className={`focus-ring block w-full border-b border-ink/10 px-4 py-4 text-left last:border-b-0 ${selected?.playerId === player.playerId ? "bg-ink/[0.06]" : "hover:bg-ink/[0.025]"}`}>
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-base font-semibold">{player.displayName}</span>
              <span className={`shrink-0 text-xs ${player.estimatedTotal !== null && player.walletTotal < player.estimatedTotal ? "text-coral" : "text-ink/60"}`}>{t(liveBilling(player).status)}</span>
            </span>
            <span className="mt-3 grid grid-cols-3 gap-3">
              <span><span className="block text-xs text-ink/60">{t("入场时间")}</span>
                <span className="mt-1 block text-xl font-semibold leading-tight tabular-nums">{player.sessions[0] ? <time dateTime={player.sessions[0].startedAt}>{clockAt(player.sessions[0].startedAt)}</time> : "—"}</span>
                <span className="mt-1 block text-xs text-ink/50">{player.sessions[0] && dayAt(player.sessions[0].startedAt)}</span>
              </span>
              <span><span className="block text-xs text-ink/60">{t("时长")}</span><strong className="mt-1 block text-xl font-semibold leading-tight tabular-nums">{stayDuration(player.stayDurationMinutes)}</strong></span>
              <span className="text-right"><span className="block text-xs text-ink/60">{t("应付")}</span><strong className="mt-1 block break-all text-xl font-semibold leading-tight tabular-nums">{money(player.estimatedTotal)}</strong><span className="mt-1 block text-xs text-ink/50">{player.sessions.length} {t("项")}</span></span>
            </span>
          </button>)}
        </div>)}
      </div>
      {selected && <section ref={billPanel} key={selected.playerId} className="min-w-0 overflow-hidden rounded-xl border border-ink/10 bg-panel" aria-label={t("账单")}>
        <header className="flex items-center justify-between gap-3 border-b border-ink/10 p-4">
          <h3 className="font-semibold">{selected.displayName} · {t("账单")}</h3>
          <button className={button} onClick={() => onManage(selected.playerId)}>{t("玩家资料")}</button>
        </header>
        <dl className="grid grid-cols-3 gap-3 border-b border-ink/10 p-4">
          <div><dt className="text-xs text-ink/60">{t("入场时间")}</dt><dd className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{selected.sessions[0] ? <time dateTime={selected.sessions[0].startedAt}>{clockAt(selected.sessions[0].startedAt)}</time> : "—"}</dd><dd className="mt-1 text-xs text-ink/50">{selected.sessions[0] && dayAt(selected.sessions[0].startedAt)}</dd></div>
          <div><dt className="text-xs text-ink/60">{t("时长")}</dt><dd className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{stayDuration(selected.stayDurationMinutes)}</dd></div>
          <div className="text-right"><dt className="text-xs text-ink/60">{t("应付")}</dt><dd className="mt-1 break-all text-2xl font-semibold leading-tight tabular-nums">{money(selected.estimatedTotal)}</dd><dd className="mt-1 text-xs text-ink/50">{t("余额")} {money(selected.walletTotal)}</dd></div>
        </dl>
        {selected.sessions.map(session => <div key={session.id} className="border-b border-ink/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div><h4 className="text-sm font-semibold">{title(session)}</h4>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold tabular-nums"><time dateTime={session.startedAt}>{at(session.startedAt)}</time><span className="font-normal text-ink/40">–</span>{session.endedAt ? <time dateTime={session.endedAt}>{at(session.endedAt)}</time> : <span>{t("至今")}</span>}</p>
              <p className="mt-2 flex items-baseline gap-2"><span className="text-xs text-ink/60">{t("时长")}</span><strong className="text-xl font-semibold tabular-nums">{stayDuration(session.elapsedMinutes)}</strong></p>
            </div>
            <div className="text-right"><strong className="text-sm tabular-nums">{money(session.currentImpact)}</strong><p className="mt-1 text-xs text-ink/60">{t(session.status === "active" ? "进行中" : "已停止")}</p></div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink/60">
            <span>{[...new Set(session.pricingCharges.map(charge => charge.planName))].join(" + ") || t("暂无计费明细")}</span>
            {canWrite && session.status === "active" && <button className="focus-ring rounded px-2 py-1 underline underline-offset-4" onClick={() => setStop({ playerId: selected.playerId, session })}>{t("停止计费")}</button>}
          </div>
          <details className="mt-2 text-sm">
            <summary className="focus-ring w-fit cursor-pointer rounded py-1 text-xs">{t("计费明细")}</summary>
            <div className="mt-2 divide-y divide-ink/10 border-t border-ink/10">
              {session.pricingSegments.map((part, index) => <div key={index} className="py-3 text-xs">
                <div className="flex justify-between gap-3"><span className="font-medium">{part.planName} · {part.ruleLabel}</span><strong className="tabular-nums">{money(part.amount)}</strong></div>
                <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold tabular-nums"><time dateTime={part.actualStartedAt}>{at(part.actualStartedAt)}</time><span className="font-normal text-ink/40">–</span><time dateTime={part.actualEndedAt}>{at(part.actualEndedAt)}</time></p>
                <p className="mt-2 flex items-baseline gap-2"><span className="text-xs text-ink/60">{t("时长")}</span><strong className="text-base font-semibold tabular-nums">{stayDuration((Date.parse(part.actualEndedAt) - Date.parse(part.actualStartedAt)) / 60000)}</strong></p>
                {part.ruleTimeRange && <p className="mt-1 text-ink/60">{t("规则时段")} {part.ruleTimeRange.start}–{part.ruleTimeRange.end <= part.ruleTimeRange.start ? t("次日") + " " : ""}{part.ruleTimeRange.end}</p>}
                {part.intervalCapReached && <p className="mt-1 font-medium">{t("已达时段封顶")} {money(part.intervalCap)}</p>}
              </div>)}
              {!session.pricingSegments.length && session.pricingCharges.map((charge, index) => <p key={index} className="flex justify-between gap-3 py-2 text-xs"><span>{charge.planName} · {charge.ruleLabel}</span><strong>{money(charge.amount)}</strong></p>)}
              {!session.pricingCharges.length && !session.pricingSegments.length && <p className="py-2 text-xs text-ink/60">{t("暂无计费明细")}</p>}
            </div>
          </details>
        </div>)}
        {!!selected.globalCapWindows?.length && <div className="border-b border-ink/10 p-4">
          <h4 className="mb-2 text-sm font-semibold">{t("跨方案封顶")}</h4>
          {selected.globalCapWindows.map(window => <details key={window.key} className="py-2 text-xs">
            <summary className="focus-ring cursor-pointer rounded">{window.ruleLabel} · {money(window.amountApplied)} / {money(window.priceCap)}{window.priceCapReached ? ` · ${t("已封顶")}` : ""}</summary>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold tabular-nums"><time dateTime={window.windowStartedAt}>{at(window.windowStartedAt)}</time><span className="font-normal text-ink/40">–</span><time dateTime={window.windowEndedAt}>{at(window.windowEndedAt)}</time></p>
            <p className="mt-1 text-ink/60">{t("历史已计入")} {money(window.paidBefore)} · {t("本次参与金额")} {money(window.currentAmount)}</p>
          </details>)}
        </div>}
        {(canWrite || error) && <footer className="p-4">
          {error && <p role="alert" className="mb-3 text-sm text-coral">{error}</p>}
          {canWrite && <button className={`${primary} w-full`} disabled={busy} onClick={previewCheckout}>{t(busy ? "正在加载" : "结账")}</button>}
        </footer>}
      </section>}
    </div>
    {stop && <Modal title="停止计费" close={() => setStop(null)}><ActionForm label="确认停止" done={() => { setStop(null); refresh(); }} submit={() => request(`players/${segment(stop.playerId)}/sessions/${segment(stop.session.id)}/stop`, "POST", {})}>
      <p className="text-sm">{title(stop.session)} · {t("停止后仍需结账")}</p>
    </ActionForm></Modal>}
    {checkout && <Modal title="结账" close={() => setCheckout(null)}><ActionForm label="确认结账" done={() => { setCheckout(null); refresh(); }} submit={() => request(`players/${segment(checkout.player.playerId)}/checkout/confirm`, "POST", {})}>
      <p className="font-semibold">{checkout.player.displayName}</p>
      {[...checkout.preview.chargeItems, ...checkout.preview.adjustments].map((item, index) => <p key={index} className="flex justify-between gap-3 text-sm"><span>{item.label}</span><span>{money(item.amount)}</span></p>)}
      <p className="flex justify-between font-semibold"><span>{t("合计")}</span><span>{money(checkout.preview.settlementPreview.total)}</span></p>
      <p className="text-sm text-ink/60">{t("结账后余额")} {money(checkout.preview.wallet.balanceAfter)}</p>
    </ActionForm></Modal>}
  </>;
}
