import { addLocalDays, formatLocalDate, parseLocalDateTime } from "@prism/core";
import { useState } from "react";
import { useI18n } from "../../i18n";
import {
  Field,
  State,
  Table,
  button,
  cell,
  input,
  money,
  useResource,
  useMerchant,
} from "./shared";

type Settlement = {
  settlementId: string;
  playerDisplayName: string;
  settledAt: string;
  durationMinutes: number;
  total: number;
};
export function ReportsPage() {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const [from, setFrom] = useState(
    () => formatLocalDate(new Date(), timeZone).slice(0, 8) + "01",
  );
  const [to, setTo] = useState(() => formatLocalDate(new Date(), timeZone));
  const [offset, setOffset] = useState(0);
  const start = from
    ? parseLocalDateTime(from, "00:00", timeZone)
    : new Date(NaN);
  const end = to
    ? parseLocalDateTime(addLocalDays(to, 1), "00:00", timeZone)
    : new Date(NaN);
  const valid =
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < end;
  const range = new URLSearchParams({
    from: valid ? start.toISOString() : "",
    to: valid ? end.toISOString() : "",
  }).toString();
  const summary = useResource<{
    summary: {
      revenueTotal: number;
      sessionCount: number;
      assetGrantTotal: number;
      coinCommandCount: number;
    };
  }>(`reports/summary?${range}`);
  const settlements = useResource<{
    settlements: Settlement[];
    page: { hasMore: boolean };
  }>(`reports/settlements?${range}&limit=50&offset=${offset}`);
  return (
    <div className="grid gap-5">
      <h2 className="text-xl font-semibold">{t("营业记录")}</h2>
      <div className="flex flex-wrap gap-3">
        <Field label="从">
          <input
            className={input}
            type="date"
            required
            value={from}
            max={to}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
        <Field label="至">
          <input
            className={input}
            type="date"
            required
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
      </div>
      {summary.data && (
        <dl className="grid grid-cols-2 gap-5 border-y border-ink/10 py-5 sm:grid-cols-4">
          {[
            ["营业额", money(summary.data.summary.revenueTotal)],
            ["消费笔数", summary.data.summary.sessionCount],
            ["发放笔数", summary.data.summary.assetGrantTotal],
            ["投币次数", summary.data.summary.coinCommandCount],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-ink/60">{t(String(label))}</dt>
              <dd className="mt-2 text-2xl font-semibold tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!valid ? (
        <State error={t("请选择有效日期")} />
      ) : !settlements.data ? (
        <State error={settlements.error || summary.error} />
      ) : !settlements.data.settlements.length ? (
        <State empty />
      ) : (
        <>
          <div className="divide-y divide-ink/10 rounded-xl bg-panel md:hidden">
            {settlements.data.settlements.map((s) => (
              <div
                key={s.settlementId}
                className="grid grid-cols-[1fr_auto] gap-2 p-4"
              >
                <strong>{s.playerDisplayName}</strong>
                <strong className="tabular-nums">{money(s.total)}</strong>
                <span className="text-xs text-ink/60">
                  {new Date(s.settledAt).toLocaleString(undefined, {
                    timeZone,
                  })}
                </span>
                <span className="text-right text-xs text-ink/60">
                  {Math.round(s.durationMinutes)} {t("分钟")}
                </span>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <Table headers={["玩家", "结账时间", "时长（分钟）", "金额"]}>
              {settlements.data.settlements.map((s) => (
                <tr key={s.settlementId}>
                  <td className={cell}>{s.playerDisplayName}</td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {new Date(s.settledAt).toLocaleString(undefined, {
                      timeZone,
                    })}
                  </td>
                  <td className={cell}>{Math.round(s.durationMinutes)}</td>
                  <td className={cell}>{money(s.total)}</td>
                </tr>
              ))}
            </Table>
          </div>
          <div className="flex justify-end gap-2">
            <button
              className={button}
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              {t("上一页")}
            </button>
            <button
              className={button}
              disabled={!settlements.data.page.hasMore}
              onClick={() => setOffset(offset + 50)}
            >
              {t("下一页")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
