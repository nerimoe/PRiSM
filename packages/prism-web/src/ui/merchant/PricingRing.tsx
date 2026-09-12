import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { Pricing } from "./Pricing";
import { input, money, useMerchant, useStaffApi } from "./shared";

type Segment = {
  ruleId: string;
  label: string;
  startMinute: number;
  endMinute: number;
  startLabel: string;
  endLabel: string;
  isClosed?: boolean;
  pricing?: { unitPrice: number; unitMinutes: number };
  priceCap?: number;
};
const colors = [
  "#209b87",
  "#5982cc",
  "#c2933e",
  "#a96ca6",
  "#cf7262",
  "#74846b",
];
const point = (minute: number, radius: number) => {
  const angle = (minute / 1440) * Math.PI * 2 - Math.PI / 2;
  return [160 + Math.cos(angle) * radius, 160 + Math.sin(angle) * radius];
};
function arc(start: number, end: number) {
  const a = point(start, 109),
    mid = point((start + end) / 2, 109),
    b = point(end, 109);
  // Two arcs also represent a full-day rule without a degenerate SVG endpoint.
  return `M ${a.join(" ")} A 109 109 0 0 1 ${mid.join(" ")} A 109 109 0 0 1 ${b.join(" ")}`;
}
export function PricingRing({
  value,
  onSelect,
}: {
  value: Pricing;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const request = useStaffApi();
  const [day, setDay] = useState(() =>
    new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date()),
  );
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const provider = JSON.stringify(value.provider);
  useEffect(() => {
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      request<{ timeline: { segments: Segment[] } }>(
        "pricing-timeline/preview",
        "POST",
        { localDate: day, provider: JSON.parse(provider) },
      )
        .then((r) => {
          if (current) {
            setSegments(r.timeline.segments);
            setError("");
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [provider, day, request]);
  const color = (s: Segment) =>
    s.isClosed
      ? "#d5d9d7"
      : colors[
          Math.max(
            0,
            value.provider.rules?.findIndex((r) => r.id === s.ruleId) ?? 0,
          ) % colors.length
        ];
  function choose(s: Segment) {
    setSelected(s.ruleId);
    if (!s.isClosed) onSelect(s.ruleId);
  }
  const active = segments.find((s) => s.ruleId === selected);
  return (
    <section
      className="grid gap-3 rounded-lg border border-ink/10 bg-ink/[.02] p-4"
      aria-label={t("24 小时计费预览")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("24 小时计费预览")}</h3>
        </div>
        <input
          className={`${input} w-auto`}
          type="date"
          aria-label={t("预览日期")}
          required
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </div>
      <div
        className="relative mx-auto w-full max-w-[320px]"
        aria-busy={loading}
      >
        <svg
          viewBox="0 0 320 320"
          className="w-full"
          aria-label={t("点击时段编辑规则")}
        >
          <circle
            cx="160"
            cy="160"
            r="109"
            fill="none"
            stroke="#e5e7e5"
            strokeWidth="32"
          />
          {!error &&
            segments.map((s, i) => (
              <path
                key={`${s.ruleId}:${i}`}
                d={arc(s.startMinute, s.endMinute)}
                fill="none"
                stroke={color(s)}
                strokeWidth={selected === s.ruleId ? 39 : 32}
                className="cursor-pointer outline-none transition-[stroke-width] focus:stroke-[42px]"
                role="button"
                tabIndex={0}
                aria-label={`${s.startLabel}–${s.endLabel} ${s.label}`}
                aria-pressed={selected === s.ruleId}
                onClick={() => choose(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(s);
                  }
                }}
              >
                <title>
                  {s.startLabel}–{s.endLabel} · {s.label}
                </title>
              </path>
            ))}
          {Array.from({ length: 8 }, (_, i) => i * 3).map((hour) => {
            const [x, y] = point(hour * 60, 144);
            return (
              <text
                key={hour}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="11"
                fill="#7a827e"
              >
                {String(hour).padStart(2, "0")}:00
              </text>
            );
          })}
          <text
            x="160"
            y="151"
            textAnchor="middle"
            fontSize="15"
            fontWeight="600"
            fill="currentColor"
          >
            {active ? active.label.slice(0, 10) : t("全天")}
          </text>
          <text
            x="160"
            y="177"
            textAnchor="middle"
            fontSize="12"
            fill="#7a827e"
          >
            {active?.pricing
              ? `${money(active.pricing.unitPrice)} / ${active.pricing.unitMinutes} ${t("分钟")}`
              : active?.priceCap != null
                ? `${t("封顶")} ${money(active.priceCap)}`
                : t("点击时段编辑规则")}
          </text>
        </svg>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      ) : (
        <div className="grid gap-1">
          {segments.map((s, i) => (
            <button
              type="button"
              key={i}
              className="focus-ring flex min-h-10 items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-ink/5"
              onClick={() => choose(s)}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: color(s) }}
              />
              <span className="tabular-nums text-ink/55">
                {s.startLabel}–{s.endLabel}
              </span>
              <span className="ml-auto truncate">
                {s.isClosed ? t("未配置") : s.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
