import { pricingInZone } from "./merchant/pricing-clock";
import type { Pricing } from "./merchant/Pricing";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import { BillingConversionWizard } from "./merchant/BillingSetup";

export type Settings = {
  billingEnabled: boolean;
  cashierEnabled: boolean;
  autoRegister: boolean;
  identityBindingRequired: boolean;
  locationEnabled: boolean;
  checkinGeo: boolean;
  checkoutGeo: boolean;
  machineGeo: boolean;
  entryPricingIds: string[];
  botContact: string;
};
export type ShopInfo = {
  entryPricing: Pricing[];
  pricingSchedule: {
    localDate: string;
    timeZone: string;
    groups: {
      id: string;
      name: string;
      kind: string;
      amount?: number;
      timeZone?: string;
      segments: {
        startLabel: string;
        endLabel: string;
        label: string;
        isClosed?: boolean;
        priceCap?: number;
        pricing?: {
          unitPrice: number;
          unitMinutes: number;
          roundGraceMinutes: number;
          priceCap: number;
        };
      }[];
    }[];
  };
  shop: Settings & { publicId: string; name: string; timeZone: string; heroUrl?: string | null };
  membership: { playerId: string; identityBound: boolean } | null;
};
export type Summary = {
  player: { displayName: string };
  wallet: { assetCode: string; quantity: number }[];
  activeSession: { id: string; startedAt: string } | null;
};
export type Preview = {
  timeline?: import("@prism/core").BillTimeline;
  settlementPreview: { total: number };
  chargeItems: { id: string; label: string; amount: number }[];
  adjustments: { id: string; label: string; amount: number }[];
  wallet: { balanceBefore: number; balanceAfter: number };
};
export type History = {
  sessions: {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    total: number | null;
    status: string;
  }[];
};
export type Assets = {
  holdings: {
    id: string;
    assetName?: string;
    assetCode: string;
    quantity: number;
    availability?: string;
  }[];
};
export const control =
  "focus-ring rounded border border-ink/15 bg-panel px-4 py-3 disabled:opacity-50";
export const panel = "rounded border border-ink/10 bg-panel p-5";
export const shopApi = (code: string, path = "") =>
  `/api/v1/shops/${encodeURIComponent(code)}${path ? `/${path}` : ""}`;
export const post = (body: unknown = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
});

export async function operationLocation(required: boolean) {
  if (!required) return undefined;
  if (!navigator.geolocation)
    throw new Error("当前浏览器不支持定位，请联系店员");
  const position = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      resolve,
      () => reject(new Error("未能获取定位，请授权后重试；未结消费仍在计时")),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    ),
  );
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
  };
}

export function BillingSettings({
  shopCode,
  embedded = false,
  section = "billing",
}: {
  shopCode: string;
  embedded?: boolean;
  section?: "billing" | "players" | "devices" | null;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedSection, setSavedSection] = useState<typeof section>(null);
  const [errorSection, setErrorSection] = useState<typeof section>(null);
  const [billingActive, setBillingActive] = useState(false);
  const [converting, setConverting] = useState(false);
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      api<Settings>(shopApi(shopCode, "settings")),
      api<{ pricingConfigs: { id: string; name: string; enabled: boolean }[] }>(
        shopApi(shopCode, "staff/pricing-configs"),
      ),
    ]);
    setSettings({
      ...s,
      cashierEnabled: s.cashierEnabled ?? false,
      identityBindingRequired: s.identityBindingRequired ?? true,
    });
    setBillingActive(s.billingEnabled);
    setRules(r.pricingConfigs);
  }, [shopCode]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  if (!settings)
    return section ? <p role="status">{error || t("加载中...")}</p> : null;
  const flags = {
    billingEnabled: "启用入场计费",
    autoRegister: "允许自动创建玩家档案",
    locationEnabled: "启用位置校验",
  } as const;
  return (
    <>
      <form
        style={section ? undefined : { display: "none" }}
        className={`${embedded ? "rounded-xl border border-ink/10 bg-panel p-5" : panel} grid gap-4`}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !section) return;
          const savingSection = section;
          setBusy(true);
          setError("");
          setSavedSection(null);
          setErrorSection(savingSection);
          try {
            const current = await api<Settings>(shopApi(shopCode, "settings"));
            const patch =
              savingSection === "billing"
                ? {
                    billingEnabled: settings.billingEnabled,
                    cashierEnabled: settings.cashierEnabled,
                    entryPricingIds: settings.entryPricingIds,
                  }
                : savingSection === "players"
                  ? {
                      identityBindingRequired: settings.identityBindingRequired,
                      autoRegister: settings.autoRegister,
                    }
                  : { locationEnabled: settings.locationEnabled };
            const result = await api<Settings>(shopApi(shopCode, "settings"), {
              method: "PUT",
              body: JSON.stringify({ ...current, ...patch }),
            });
            setBillingActive(result.billingEnabled);
            setSavedSection(savingSection);
            window.dispatchEvent(new Event("prism-shop-settings"));
          } catch (e) {
            setError(e instanceof Error ? e.message : t("保存失败"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="grid gap-4">
          <h4 className="font-semibold">
            {t(
              section === "players"
                ? "注册与身份绑定"
                : section === "devices"
                  ? "位置校验"
                  : "入场与收银",
            )}
          </h4>
          {section === "billing" && !billingActive && (
            <div className="grid gap-3 rounded-lg bg-ink/5 p-4 text-sm">
              <p>{t("通过向导设置收费标准，一次完成基础配置并启用计费。")}</p>
              <button
                type="button"
                className={`${control} justify-self-start`}
                onClick={() => setConverting(true)}
              >
                {t("转换为计费店铺")}
              </button>
              <div className="flex flex-wrap gap-3">
                <Link className="underline" to={`/merchant/${shopCode}/assets`}>
                  {t("配置基础资产")}
                </Link>
                <Link
                  className="underline"
                  to={`/merchant/${shopCode}/pricing`}
                >
                  {t("配置入场规则")}
                </Link>
              </div>
            </div>
          )}
          {section === "billing" && (
            <>
              <label className="grid gap-2">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.billingEnabled}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        billingEnabled: e.target.checked,
                        cashierEnabled:
                          e.target.checked && settings.cashierEnabled,
                      })
                    }
                  />
                  {t(flags.billingEnabled)}
                </span>
              </label>
              <label className="grid gap-2">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.cashierEnabled}
                    disabled={!settings.billingEnabled}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        cashierEnabled: e.target.checked,
                      })
                    }
                  />
                  {t("启用前台收银")}
                </span>
                <span className="pl-7 text-sm leading-relaxed text-ink/60">
                  {t(
                    "默认关闭。开启后，在「在店」页面连接读卡器，使用卡片昵称档案计时并现场收款。关闭前须结清前台账单。",
                  )}
                </span>
              </label>
            </>
          )}
          {section === "players" && (
            <>
              <label className="grid gap-2">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.identityBindingRequired}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        identityBindingRequired: e.target.checked,
                      })
                    }
                  />
                  {t("要求绑定平台身份")}
                </span>
                <span className="pl-7 text-sm leading-relaxed text-ink/60">
                  {t(
                    "开启后，绑定任意一个 Bot 平台身份即可入场和使用设备；关闭后，登录网页账号即可使用。",
                  )}
                </span>
              </label>
              <label className="grid gap-2">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.autoRegister}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        autoRegister: e.target.checked,
                      })
                    }
                  />
                  {t(flags.autoRegister)}
                </span>
                <span className="pl-7 text-sm leading-relaxed text-ink/60">
                  {t(
                    "开启后，验证平台身份可创建新玩家档案；关闭后，仅可认领已有平台身份档案。",
                  )}
                </span>
              </label>
            </>
          )}
          {section === "devices" && (
            <label className="grid gap-2">
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={settings.locationEnabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      locationEnabled: e.target.checked,
                    })
                  }
                />
                {t(flags.locationEnabled)}
              </span>
              <span className="pl-7 text-sm leading-relaxed text-ink/60">
                {t(
                  "位置校验开启后，入场、开门、开机、投币和刷卡均须在店内；离场结账须定位确认已在店外。范围使用店铺地图设置。",
                )}
              </span>
            </label>
          )}

          {section === "billing" && (
            <fieldset>
              <legend>{t("普通入场计费规则")}</legend>
              {!rules.some((rule) => rule.enabled) && (
                <p className="mt-2 text-sm text-ink/60">
                  {t("暂无启用的入场规则，请先在计费管理中配置。")}
                </p>
              )}
              {rules
                .filter((r) => r.enabled)
                .map((rule) => (
                  <label className="mt-2 flex gap-3" key={rule.id}>
                    <input
                      type="checkbox"
                      checked={settings.entryPricingIds.includes(rule.id)}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          entryPricingIds: e.target.checked
                            ? [...settings.entryPricingIds, rule.id]
                            : settings.entryPricingIds.filter(
                                (id) => id !== rule.id,
                              ),
                        })
                      }
                    />
                    {rule.name}
                  </label>
                ))}
            </fieldset>
          )}
          {error && errorSection === section && <p role="alert">{error}</p>}
          {savedSection === section && <p role="status">{t("已保存")}</p>}
          <button className={`${control} justify-self-start`} disabled={busy}>
            {t(
              section === "players"
                ? "保存身份设置"
                : section === "devices"
                  ? "保存位置校验"
                  : "保存计费设置",
            )}
          </button>
        </fieldset>
        {section === "billing" && (
          <Link className="underline" to={`/merchant/${shopCode}/pricing`}>
            {t("打开计费管理")}
          </Link>
        )}
      </form>
      {converting && (
        <BillingConversionWizard
          shopCode={shopCode}
          close={() => setConverting(false)}
          done={async (value) => {
            setSettings((previous) => ({
              ...value,
              autoRegister: previous?.autoRegister ?? value.autoRegister,
              identityBindingRequired:
                previous?.identityBindingRequired ??
                value.identityBindingRequired,
              locationEnabled:
                previous?.locationEnabled ?? value.locationEnabled,
            }));
            setBillingActive(value.billingEnabled);
            setConverting(false);
            setSavedSection("billing");
            setError("");
            const result = await api<{
              pricingConfigs: { id: string; name: string; enabled: boolean }[];
            }>(shopApi(shopCode, "staff/pricing-configs"));
            setRules(result.pricingConfigs);
          }}
        />
      )}
    </>
  );
}

export function EntryPricing({ info }: { info: ShopInfo }) {
  const { t, locale } = useI18n();
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const plans = info.entryPricing.map(plan => pricingInZone(plan, plan.kind === "charge.fixed" ? "UTC" : plan.provider.timeZone ?? "UTC", info.shop.timeZone ?? "UTC", info.pricingSchedule.localDate)).filter(
    (plan) => plan.enabled !== false && plan.status !== "archived",
  );
  return (
    <div className="entry-pricing">
      {plans.map((plan) => (
        <div key={plan.id} className="pricing-group">
          <h3>{plan.name}</h3>
          {plan.kind === "charge.fixed" ? (
            <p>
              {t("每次入场")} · {plan.provider.amount?.toFixed(2)}
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-ink/60">
                {t("时段重叠时，按下方从上到下的顺序采用规则。")}
              </p>
              {plan.provider.rules
                ?.filter((rule) => rule.status !== "archived")
                .map((rule) => (
                  <div className="pricing-segment" key={rule.id}>
                    <span className="font-mono text-sm text-ink/60">
                      {!rule.timeRange
                        ? t("连续时段")
                        : rule.timeRange.start === rule.timeRange.end
                          ? t("全天")
                          : `${rule.timeRange.start}–${rule.timeRange.start > rule.timeRange.end ? t("次日") : ""}${rule.timeRange.end}`}
                    </span>
                    <div>
                      <strong>{rule.label}</strong>
                      {!!rule.weekdays?.length && (
                        <p className="text-xs text-ink/60">
                          {rule.weekdays
                            .map((day) =>
                              weekday.format(
                                new Date(Date.UTC(2026, 0, 4 + day)),
                              ),
                            )
                            .join(" · ")}
                        </p>
                      )}
                      {!!rule.specificDates?.length && (
                        <p className="text-xs text-ink/60">
                          {rule.specificDates.join(" · ")}
                        </p>
                      )}
                      {rule.displayDateTimeRange && (
                        <p className="text-xs text-ink/60">
                          {rule.displayDateTimeRange.start} –{" "}
                          {rule.displayDateTimeRange.end}
                        </p>
                      )}
                      <p>
                        {rule.pricing
                          ? `${rule.pricing.unitPrice.toFixed(2)} / ${rule.pricing.unitMinutes} ${t("分钟")}`
                          : `${t("合计封顶")} ${rule.priceCap?.toFixed(2)}`}
                      </p>
                      {rule.pricing && (
                        <p className="text-xs text-ink/60">
                          {rule.pricing.priceCap < Number.MAX_SAFE_INTEGER &&
                            `${t("时段封顶")} ${rule.pricing.priceCap.toFixed(2)}`}
                          {rule.pricing.roundGraceMinutes > 0 &&
                            ` · ${t("每计费单位宽限")} ${rule.pricing.roundGraceMinutes} ${t("分钟")}`}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>
      ))}
      {plans.some((plan) => plan.kind !== "charge.fixed") && (
        <p className="text-xs leading-relaxed text-ink/50">
          {t(
            "按时段分别计费，不足一个单位向上取整，宽限内不计下一单位。封顶按规则时段累计，跨午夜的同一时段连续累计。",
          )}
        </p>
      )}
    </div>
  );
}
