import {
  formatGeneratedRedeemCode,
  generateRedeemCodeToken,
  parseLocalDateTime,
} from "@prism/core";
import { Download, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import type { Present, RedeemCode } from "./asset-types";
import {
  codeUsage,
  codeValidity,
  type CodeUsage,
  type CodeValidity,
} from "./redeem-code-export";
import { RedeemCodeExport } from "./RedeemCodeExport";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  buttonQuiet,
  cell,
  input,
  primary,
  staffMessage,
  useStaffApi,
} from "./shared";

const REDEEM_CODE_PAGE_SIZE = 30;
const tableBtn = `${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`;

type RedeemCodesPageResponse = {
  redeemCodes: RedeemCode[];
  page?: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
};

const USAGE_BADGE: Record<CodeUsage, { label: string; tone: string }> = {
  unused: { label: "未使用", tone: "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400" },
  partial: { label: "部分使用", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  exhausted: { label: "已用完", tone: "bg-ink/5 text-ink/60" },
  revoked: { label: "已撤销", tone: "bg-coral/10 text-coral" },
};

const VALIDITY_BADGE: Partial<Record<CodeValidity, { label: string; tone: string }>> = {
  pending: { label: "未生效", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  expired: { label: "已过期", tone: "bg-coral/10 text-coral" },
};

function toIsoOrNull(localDateTime: string, timeZone: string): string | null {
  const trimmed = localDateTime.trim();
  if (!trimmed) return null;
  return parseLocalDateTime(trimmed.slice(0, 10), trimmed.slice(11, 16), timeZone).toISOString();
}

export function RedeemCodesTab({
  presents,
  canWrite,
  timeZone,
  reloadKey,
  onCreate,
  onOpenGifts,
  onViewDetail,
  onRevoke,
}: {
  presents: Present[];
  canWrite: boolean;
  timeZone: string;
  reloadKey: number;
  onCreate: () => void;
  onOpenGifts: () => void;
  onViewDetail: (code: RedeemCode) => void;
  onRevoke: (code: RedeemCode) => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [presentId, setPresentId] = useState("");
  const [usage, setUsage] = useState<"" | CodeUsage>("");
  const [validity, setValidity] = useState<"" | CodeValidity>("");
  const [exporting, setExporting] = useState(false);

  const [items, setItems] = useState<RedeemCode[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");

  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const hasFilter = Boolean(debouncedSearch || presentId || usage || validity);
  const activePresents = presents.some((p) => p.status !== "archived");

  const buildPath = useCallback(
    (offset: number) => {
      const qs = new URLSearchParams({
        limit: String(REDEEM_CODE_PAGE_SIZE),
        offset: String(offset),
      });
      if (presentId) qs.set("presentId", presentId);
      if (usage) qs.set("usage", usage);
      if (validity) qs.set("validity", validity);
      if (debouncedSearch) qs.set("search", debouncedSearch);
      return `redeem-codes?${qs.toString()}`;
    },
    [presentId, usage, validity, debouncedSearch],
  );

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    inFlightRef.current = true;
    setLoading(true);
    setError("");
    setLoadMoreError("");
    request<RedeemCodesPageResponse>(buildPath(0))
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        const nextTotal = res.page?.total ?? res.redeemCodes.length;
        setItems(res.redeemCodes);
        setTotal(nextTotal);
        setHasMore(Boolean(res.page?.hasMore));
      })
      .catch((caught) => {
        if (seq !== requestSeqRef.current) return;
        setError(caught instanceof Error ? staffMessage(caught) : t("操作失败"));
      })
      .finally(() => {
        if (seq === requestSeqRef.current) {
          inFlightRef.current = false;
          setLoading(false);
        }
      });
  }, [buildPath, reloadKey, request, t]);

  const loadMore = useCallback(() => {
    if (!hasMore || inFlightRef.current) return;
    const seq = requestSeqRef.current;
    inFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    request<RedeemCodesPageResponse>(buildPath(items.length))
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map((row) => row.id));
          const appended = res.redeemCodes.filter((row) => !seen.has(row.id));
          return [...prev, ...appended];
        });
        setTotal(res.page?.total ?? items.length + res.redeemCodes.length);
        setHasMore(Boolean(res.page?.hasMore));
      })
      .catch((caught) => {
        if (seq !== requestSeqRef.current) return;
        setLoadMoreError(caught instanceof Error ? staffMessage(caught) : t("操作失败"));
      })
      .finally(() => {
        if (seq === requestSeqRef.current) {
          inFlightRef.current = false;
          setLoadingMore(false);
        }
      });
  }, [buildPath, hasMore, items.length, request, t]);

  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    if (!hasMore || loading || loadingMore || loadMoreError || typeof IntersectionObserver === "undefined") {
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRef.current();
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadMoreError]);

  function resetFilters() {
    setSearch("");
    setDebouncedSearch("");
    setPresentId("");
    setUsage("");
    setValidity("");
  }

  const date = (value: string | null | undefined) =>
    value ? displayDateTime(value, timeZone) : "—";
  const now = new Date();

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 rounded-2xl border border-ink/10 bg-panel p-4">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
          <input
            className={input}
            type="search"
            value={search}
            placeholder={t("搜索兑换码或前缀")}
            aria-label={t("搜索兑换码或前缀")}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className={input}
            value={presentId}
            aria-label={t("绑定礼物")}
            onChange={(e) => setPresentId(e.target.value)}
          >
            <option value="">{t("全部礼物")}</option>
            {presents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.status === "archived" ? `${p.name}（${t("已归档")}）` : p.name}
              </option>
            ))}
          </select>
          <select
            className={input}
            value={usage}
            aria-label={t("使用状态")}
            onChange={(e) => setUsage(e.target.value as "" | CodeUsage)}
          >
            <option value="">{t("全部使用状态")}</option>
            <option value="unused">{t("未使用")}</option>
            <option value="partial">{t("部分使用")}</option>
            <option value="exhausted">{t("已用完")}</option>
            <option value="revoked">{t("已撤销")}</option>
          </select>
          <select
            className={input}
            value={validity}
            aria-label={t("有效状态")}
            onChange={(e) => setValidity(e.target.value as "" | CodeValidity)}
          >
            <option value="">{t("全部有效状态")}</option>
            <option value="valid">{t("有效")}</option>
            <option value="pending">{t("未生效")}</option>
            <option value="expired">{t("已过期")}</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/60">
          <span>
            {loading && !items.length
              ? t("加载中...")
              : t("共 {total} 个兑换码", { total })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {(hasFilter || search) && (
              <button type="button" className={buttonQuiet} onClick={resetFilters}>
                {t("重置筛选")}
              </button>
            )}
            {(total > 0 || hasFilter) && (
              <button type="button" className={tableBtn} onClick={() => setExporting(true)}>
                <Download size={14} />
                {t("导出兑换码")}
              </button>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <State error={error} />
      ) : loading && !items.length ? (
        <State />
      ) : !items.length ? (
        hasFilter ? (
          <div className="rounded-xl border border-dashed border-ink/20 px-6 py-12 text-center">
            <p className="font-medium">{t("没有符合条件的兑换码")}</p>
            <button type="button" className={`${button} mt-4`} onClick={resetFilters}>
              {t("重置筛选")}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
            <p className="font-medium">{t("还没有兑换码")}</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/55">
              {t(
                activePresents
                  ? "兑换码让玩家自己领取礼物。"
                  : "兑换码让玩家自己领取礼物，先创建一个礼物。",
              )}
            </p>
            {canWrite && (
              <button
                type="button"
                className={`${primary} mt-5`}
                onClick={activePresents ? onCreate : onOpenGifts}
              >
                <Plus size={16} />
                {t(activePresents ? "新建兑换码" : "创建礼物")}
              </button>
            )}
          </div>
        )
      ) : (
        <>
          <Table headers={["兑换码", "礼物", "使用次数", "状态", "到期", "操作"]}>
            {items.map((c) => {
              const u = codeUsage(c);
              const v = codeValidity(c, now);
              const usageBadge = USAGE_BADGE[u];
              const validityBadge = VALIDITY_BADGE[v];
              return (
                <tr key={c.id}>
                  <td className={cell}>
                    <code className="select-all font-medium">{c.code}</code>
                    {c.redemptions?.length ? (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer font-medium text-ink/65">
                          {t("兑换记录")} ({c.redemptions.length})
                        </summary>
                        <div className="bill-entry !mb-0 !mt-1.5 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
                          {c.redemptions.map((r, i) => (
                            <div
                              key={i}
                              className="flex items-baseline justify-between gap-3 px-2.5 py-1.5"
                            >
                              <span className="font-medium text-ink">
                                {r.playerDisplayName}
                              </span>
                              <span className="text-ink/55 tabular-nums">
                                {date(r.redeemedAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </td>
                  <td className={cell}>
                    {presents.find((p) => p.id === c.presentId)?.name ?? "—"}
                  </td>
                  <td className={cell}>
                    {c.usageCount} / {c.maxUseCount}
                  </td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-1.5">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${usageBadge.tone}`}
                      >
                        {t(usageBadge.label)}
                      </span>
                      {validityBadge && (
                        <span
                          className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${validityBadge.tone}`}
                        >
                          {t(validityBadge.label)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {date(c.expiresAt)}
                  </td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={tableBtn}
                        onClick={() => onViewDetail(c)}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && c.maxUseCount > 0 && (
                        <button
                          className={tableBtn}
                          onClick={() => onRevoke(c)}
                        >
                          {t("撤销")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>

          <div ref={sentinelRef} className="h-1" aria-hidden="true" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/55">
            <span>
              {hasMore
                ? t("已加载 {loaded} / {total}", { loaded: items.length, total })
                : t("已显示全部 {total} 个兑换码", { total })}
            </span>
            {loadMoreError ? (
              <button type="button" className={tableBtn} onClick={loadMore}>
                {t("重试")}
              </button>
            ) : hasMore ? (
              <button
                type="button"
                className={tableBtn}
                disabled={loadingMore}
                onClick={loadMore}
              >
                {t(loadingMore ? "加载中..." : "加载更多")}
              </button>
            ) : null}
          </div>
        </>
      )}

      {exporting && (
        <RedeemCodeExport
          presents={presents}
          timeZone={timeZone}
          initialFilter={{
            presentIds: presentId ? [presentId] : [],
            usage: usage ? [usage] : [],
            validity: validity ? [validity] : [],
            search: search.trim(),
          }}
          close={() => setExporting(false)}
        />
      )}
    </div>
  );
}

export function RedeemCodeCreateModal({
  presents,
  timeZone,
  onClose,
  onDone,
}: {
  presents: Present[];
  timeZone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [mode, setMode] = useState<"batch" | "custom">("batch");
  const [prefix, setPrefix] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [sampleToken] = useState(() => generateRedeemCodeToken());

  const previewSample = useMemo(() => {
    try {
      return formatGeneratedRedeemCode(prefix, sampleToken);
    } catch {
      return sampleToken;
    }
  }, [prefix, sampleToken]);

  return (
    <Modal title="新建兑换码" close={onClose}>
      <ActionForm
        done={onDone}
        label={mode === "batch" ? "生成" : "创建"}
        submit={(f) => {
          const presentId = String(f.get("present") ?? "");
          const maxUseCount = Number(f.get("uses"));
          const activeAt = toIsoOrNull(String(f.get("active") ?? ""), timeZone);
          const expiresAt = toIsoOrNull(String(f.get("expires") ?? ""), timeZone);
          if (activeAt && expiresAt && Date.parse(expiresAt) <= Date.parse(activeAt)) {
            throw new Error(t("到期时间必须晚于生效时间"));
          }
          if (mode === "custom") {
            const trimmed = customCode.trim();
            if (!trimmed || /\s/.test(trimmed)) {
              throw new Error(t("兑换码不能为空且不能包含空格"));
            }
            return request("redeem-codes", "POST", {
              code: trimmed,
              presentId,
              maxUseCount,
              activeAt,
              expiresAt,
            });
          }
          const trimmedPrefix = prefix.trim();
          if (/\s/.test(trimmedPrefix)) {
            throw new Error(t("前缀不能包含空格"));
          }
          return request("redeem-codes/batch", "POST", {
            presentId,
            prefix: trimmedPrefix,
            count: Number(f.get("count")),
            maxUseCount,
            activeAt,
            expiresAt,
          });
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("创建方式")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["batch", "批量随机生成", "随机生成多个标准格式兑换码，前缀可选"],
                ["custom", "自定义兑换码", "手动指定一个兑换码，适合活动口令或定向发放"],
              ] as const
            ).map(([value, title, hint]) => (
              <label
                key={value}
                className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                  mode === value
                    ? "border-mint/50 bg-mint/[0.04]"
                    : "border-ink/15"
                }`}
              >
                <input
                  type="radio"
                  name="redeemCreateMode"
                  className="mt-0.5"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span className="min-w-0">
                  <strong className="block font-medium">{t(title)}</strong>
                  <span className="mt-0.5 block text-xs text-ink/55">{t(hint)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="礼物">
          <select className={input} required name="present" defaultValue="">
            <option value="" disabled>
              {t("请选择")}
            </option>
            {presents
              .filter((p) => p.status !== "archived")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>

        {mode === "batch" ? (
          <>
            <div className="grid gap-1.5">
              <Field label="前缀">
                <input
                  className={input}
                  name="prefix"
                  maxLength={24}
                  value={prefix}
                  placeholder={t("可选，不填则不加前缀")}
                  onChange={(e) => setPrefix(e.target.value)}
                />
              </Field>
              <p className="text-xs text-ink/55">
                {t("生成示例：{sample}", { sample: previewSample })}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="生成数量">
                <input
                  className={input}
                  name="count"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
              <Field label="每码可用次数">
                <input
                  className={input}
                  name="uses"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t("兑换码")}</span>
              <div className="flex gap-2">
                <input
                  className={input}
                  name="code"
                  maxLength={64}
                  value={customCode}
                  placeholder={t("例如 WELCOME2026，不能包含空格")}
                  onChange={(e) => setCustomCode(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className={button}
                  onClick={() => setCustomCode(generateRedeemCodeToken())}
                >
                  <RefreshCw size={15} />
                  {t("随机填入")}
                </button>
              </div>
            </div>
            <Field label="每码可用次数">
              <input
                className={input}
                name="uses"
                type="number"
                min="1"
                step="1"
                defaultValue="1"
                required
              />
            </Field>
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Field label="生效时间">
              <input className={input} type="datetime-local" name="active" />
            </Field>
            <p className="text-xs text-ink/50">{t("留空表示立即生效")}</p>
          </div>
          <div className="grid gap-1.5">
            <Field label="到期时间">
              <input className={input} type="datetime-local" name="expires" />
            </Field>
            <p className="text-xs text-ink/50">{t("留空表示永久有效")}</p>
          </div>
        </div>
      </ActionForm>
    </Modal>
  );
}
