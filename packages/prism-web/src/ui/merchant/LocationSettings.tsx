import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Save } from "lucide-react";
import {
  Api,
  api,
  normalizeResourceLocationMode,
  type Resource,
  type Shop,
  type ShopBeacon,
} from "../../api";
import { useI18n } from "../../i18n";
import { shopApi, type Settings as ShopSettings } from "../BillingPages";
import { MapPicker } from "../MapPicker";
import { State, buttonQuiet, input, primary, segment, useMerchant } from "./shared";

const RSSI_PRESETS = [
  { value: -65, label: "近 · 1~2m", short: "近" },
  { value: -75, label: "标准 · 3~5m", short: "标准" },
  { value: -85, label: "远 · 8m+", short: "远" },
] as const;

function rssiPresetLabel(rssi: number | null | undefined): string | null {
  if (rssi == null) return null;
  if (rssi >= -70) return "近";
  if (rssi <= -80) return "远";
  return "标准";
}

function parseCoordinate(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function LocationSettings({
  shop,
  onShopSaved,
}: {
  shop: Shop;
  onShopSaved: () => void | Promise<void>;
}) {
  const { t, errorText } = useI18n();
  const { shopId, shopCode } = useMerchant();
  const resourcesPath = `/merchant/${segment(shopCode)}/resources`;

  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [beacons, setBeacons] = useState<ShopBeacon[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loadError, setLoadError] = useState("");

  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const [policySaved, setPolicySaved] = useState(false);

  const [latitude, setLatitude] = useState<number | null>(shop.latitude);
  const [longitude, setLongitude] = useState<number | null>(shop.longitude);
  const [radiusMeters, setRadiusMeters] = useState(String(shop.radiusMeters ?? shop.radius_meters ?? 80));
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState("");
  const [geoSaved, setGeoSaved] = useState(false);

  const [clearingId, setClearingId] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState("");

  useEffect(() => {
    setLatitude(shop.latitude);
    setLongitude(shop.longitude);
    setRadiusMeters(String(shop.radiusMeters ?? shop.radius_meters ?? 80));
  }, [shop.id, shop.latitude, shop.longitude, shop.radiusMeters, shop.radius_meters]);

  const loadAll = useCallback(async () => {
    try {
      const [s, b, m] = await Promise.all([
        api<ShopSettings>(shopApi(shopCode, "settings")),
        Api.beacons(shopId).catch(() => ({ beacons: [] })),
        Api.machines(shopId).catch(() => ({ machines: [] })),
      ]);
      setSettings(s);
      setBeacons(b.beacons);
      setResources(m.machines);
      setLoadError("");
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : t("操作失败"));
    }
  }, [shopCode, shopId, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const onlineBeacons = beacons.filter((b) => b.online);
  const usingBle = onlineBeacons.length > 0;
  const displayRadius = shop.radiusMeters ?? shop.radius_meters ?? 80;

  async function savePolicy(e: FormEvent) {
    e.preventDefault();
    if (!settings || policyBusy) return;
    setPolicyBusy(true);
    setPolicyError("");
    setPolicySaved(false);
    try {
      const current = await api<ShopSettings>(shopApi(shopCode, "settings"));
      const saved = await api<ShopSettings>(shopApi(shopCode, "settings"), {
        method: "PUT",
        body: JSON.stringify({
          ...current,
          locationEnabled: undefined,
          checkinGeo: settings.checkinGeo,
          checkoutGeo: settings.checkoutGeo,
          machineGeo: settings.machineGeo,
          locationRssiThreshold: settings.locationRssiThreshold ?? -75,
        }),
      });
      setSettings((prev) => (prev ? { ...prev, ...saved } : saved));
      setPolicySaved(true);
      window.dispatchEvent(new Event("prism-shop-settings"));
    } catch (caught) {
      setPolicyError(caught instanceof Error ? caught.message : t("保存失败"));
    } finally {
      setPolicyBusy(false);
    }
  }

  async function saveGeofence(e: FormEvent) {
    e.preventDefault();
    if (geoBusy) return;
    if (latitude === null || longitude === null) {
      setGeoError("请在地图上选择或填写店铺位置");
      return;
    }
    const radius = Number(radiusMeters);
    if (!Number.isFinite(radius) || radius < 30 || radius > 1000) {
      setGeoError("店铺定位范围必须在 30 到 1000 米之间");
      return;
    }
    setGeoBusy(true);
    setGeoError("");
    setGeoSaved(false);
    try {
      await Api.updateShop(shop.id, {
        name: shop.name,
        latitude,
        longitude,
        radiusMeters: radius,
      });
      setGeoSaved(true);
      window.dispatchEvent(new Event("prism-shop-settings"));
      await onShopSaved();
    } catch (caught) {
      setGeoError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setGeoBusy(false);
    }
  }

  async function resetResourceOverride(resource: Resource) {
    if (clearingId) return;
    setClearingId(resource.id);
    setOverrideError("");
    try {
      await api(`/api/v1/merchant/machines/${encodeURIComponent(resource.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          shopId,
          locationOverride: { mode: "inherit", beaconNodeId: null, rssiThreshold: null },
        }),
      });
      setResources((prev) =>
        prev.map((item) =>
          item.id === resource.id
            ? { ...item, locationOverride: { mode: "inherit", beaconNodeId: null, rssiThreshold: null } }
            : item,
        ),
      );
    } catch (caught) {
      setOverrideError(caught instanceof Error ? caught.message : t("保存失败"));
    } finally {
      setClearingId(null);
    }
  }

  if (!settings) {
    return loadError ? <p role="alert" className="text-sm text-coral">{loadError}</p> : <State />;
  }

  const beaconById = new Map(beacons.map((b) => [b.nodeId, b]));
  const overriddenResources = resources.filter(
    (r) => normalizeResourceLocationMode(r.locationOverride?.mode) !== "inherit",
  );

  return (
    <div data-tour="settings-location-panel" className="grid gap-5">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
          usingBle
            ? "border-mint/35 bg-mint/[0.08]"
            : "border-ink/10 bg-panel"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${usingBle ? "bg-mint" : "bg-ink/40"}`}
            aria-hidden="true"
          />
          <span className="font-medium">
            {usingBle
              ? t("当前生效：蓝牙信标（{count} 个在线）", { count: onlineBeacons.length })
              : t("当前生效：GPS 围栏（{radius} 米）", { radius: displayRadius })}
          </span>
          <span className="text-xs text-ink/60">
            {usingBle
              ? t("在线蓝牙信标优先；全部信标离线时自动回退 GPS 围栏。")
              : t("未检测到在线蓝牙信标；部署并上线 IoT 蓝牙信标后自动切换为蓝牙定位。")}
          </span>
        </div>
        <Link className="text-xs font-medium text-mint underline" to={resourcesPath}>
          {t("管理 IoT 信标")}
        </Link>
      </div>

      <form
        onSubmit={savePolicy}
        className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="font-semibold">{t("校验开关")}</h4>
          <span className="text-xs text-ink/55">
            {t("入场与资源操作须在店内，离场结账须在店外。")}
          </span>
        </div>
        <fieldset disabled={policyBusy} className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {([
              ["checkinGeo", "入场校验", "入场与门禁须在店内"],
              ["checkoutGeo", "离场结账", "结账时须离开店铺"],
              ["machineGeo", "资源操作默认", "刷卡、投币、电源、空调等须在店内"],
            ] as const).map(([flag, label, desc]) => {
              const checked = settings[flag];
              return (
                <label
                  key={flag}
                  className={`flex cursor-pointer items-start justify-between gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors ${
                    checked
                      ? "border-mint/60 bg-mint/[0.06]"
                      : "border-ink/10 bg-ink/[0.02] hover:bg-ink/[0.04]"
                  }`}
                >
                  <span className="grid gap-0.5">
                    <span className="font-medium">{t(label)}</span>
                    <span className="text-xs text-ink/55">{t(desc)}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-[var(--color-mint)]"
                    checked={checked}
                    onChange={(e) => {
                      setSettings({ ...settings, [flag]: e.target.checked });
                      setPolicySaved(false);
                    }}
                  />
                </label>
              );
            })}
          </div>

          <div className="grid gap-3 rounded-xl border border-ink/10 bg-ink/[0.02] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{t("蓝牙信标池（优先）")}</span>
              <span className="text-xs text-ink/55">
                {beacons.length > 0
                  ? t("{online} 在线 / 共 {total} 个", { online: onlineBeacons.length, total: beacons.length })
                  : t("暂未启用蓝牙信标")}
              </span>
            </div>
            {beacons.length > 0 ? (
              <div className="grid gap-1.5">
                {beacons.map((b) => (
                  <div
                    key={b.nodeId}
                    className="flex items-center justify-between gap-2 rounded-lg border border-ink/[0.08] bg-panel px-3 py-2 text-xs"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className={`size-2 rounded-full ${b.online ? "bg-mint" : "bg-ink/30"}`}
                        aria-hidden="true"
                      />
                      <span>{b.nodeName}</span>
                      <span className="font-mono text-ink/50">#{b.beaconId}</span>
                    </span>
                    <span className={b.online ? "text-mint" : "text-ink/45"}>
                      {t(b.online ? "在线" : "离线")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-ink/55">
                {t("在资源管理中为 IoT 控制器开启「蓝牙近场信标广播」后，设备上线即自动加入本店蓝牙信标池并优先用于位置校验。")}{" "}
                <Link className="underline" to={resourcesPath}>
                  {t("前往资源管理")}
                </Link>
              </p>
            )}
            <div className="grid gap-1.5 pt-1 text-sm">
              <span className="text-xs font-medium text-ink/75">{t("默认蓝牙感应距离")}</span>
              <div
                role="group"
                aria-label={t("默认蓝牙感应距离")}
                className="grid min-h-10 grid-cols-3 overflow-hidden rounded-lg border border-ink/20 bg-panel"
              >
                {RSSI_PRESETS.map((preset, idx) => {
                  const current = settings.locationRssiThreshold ?? -75;
                  const active =
                    preset.value === -65
                      ? current >= -70
                      : preset.value === -85
                        ? current <= -80
                        : current > -80 && current < -70;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={active}
                      className={`focus-ring px-2 py-2 text-xs font-medium transition-colors ${
                        idx > 0 ? "border-l border-ink/15" : ""
                      } ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-ink/70 hover:bg-ink/5 hover:text-ink"
                      }`}
                      onClick={() => {
                        setSettings({ ...settings, locationRssiThreshold: preset.value });
                        setPolicySaved(false);
                      }}
                    >
                      {t(preset.label)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {policyError && <p role="alert" className="text-sm text-coral">{policyError}</p>}
          <div className="flex items-center gap-3">
            <button className={primary} disabled={policyBusy}>
              {t(policyBusy ? "处理中…" : "保存位置校验")}
            </button>
            {policySaved && <span role="status" className="text-sm text-mint">{t("已保存")}</span>}
          </div>
        </fieldset>
      </form>

      <form
        onSubmit={saveGeofence}
        className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="font-semibold">{t("GPS 地图与围栏（无在线信标时自动使用）")}</h4>
          <span className="font-mono text-xs text-ink/55">{radiusMeters || displayRadius} m</span>
        </div>
        {geoError && (
          <p role="alert" className="rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
            {errorText(geoError)}
          </p>
        )}
        <MapPicker
          latitude={latitude}
          longitude={longitude}
          onChange={(lat, lng) => {
            setLatitude(lat);
            setLongitude(lng);
            setGeoSaved(false);
          }}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-xs text-ink/70">
            {t("纬度 (Latitude)")}
            <input
              className={`${input} font-mono`}
              value={latitude ?? ""}
              onChange={(event) => {
                setLatitude(parseCoordinate(event.target.value));
                setGeoSaved(false);
              }}
              required
            />
          </label>
          <label className="grid gap-1 text-xs text-ink/70">
            {t("经度 (Longitude)")}
            <input
              className={`${input} font-mono`}
              value={longitude ?? ""}
              onChange={(event) => {
                setLongitude(parseCoordinate(event.target.value));
                setGeoSaved(false);
              }}
              required
            />
          </label>
          <label className="grid gap-1 text-xs text-ink/70">
            <span className="flex items-center justify-between">
              <span>{t("围栏半径")}</span>
              <span className="text-ink/45">{t("30 ~ 1000 米")}</span>
            </span>
            <div className="relative">
              <input
                type="number"
                min={30}
                max={1000}
                className={`${input} pr-9`}
                value={radiusMeters}
                onChange={(event) => {
                  setRadiusMeters(event.target.value);
                  setGeoSaved(false);
                }}
                inputMode="numeric"
                required
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink/50">
                {t("米")}
              </span>
            </div>
          </label>
        </div>
        <p className="text-xs leading-relaxed text-ink/55">
          {t("以地图标记为中心；无在线蓝牙信标时，范围内允许入场和资源操作，离场结账须在范围外。")}
        </p>
        <div className="flex items-center gap-3">
          <button className={primary} disabled={geoBusy}>
            <Save size={16} />
            {t(geoBusy ? "处理中…" : "保存地理围栏")}
          </button>
          {geoSaved && <span role="status" className="text-sm text-mint">{t("已保存")}</span>}
        </div>
      </form>

      <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="font-semibold">{t("单独覆盖定位的资源")}</h4>
            <p className="mt-0.5 text-xs text-ink/55">
              {t("单个资源的定位覆盖作用于该资源上的所有操作，优先级高于店铺默认开关。")}
            </p>
          </div>
          <Link className="text-xs font-medium text-mint underline" to={resourcesPath}>
            {t("前往资源管理")}
          </Link>
        </div>
        {overrideError && <p role="alert" className="text-sm text-coral">{overrideError}</p>}
        {overriddenResources.length === 0 ? (
          <p className="text-xs text-ink/50">
            {t("当前所有资源均跟随店铺默认位置设置。如需为门锁限定门口信标或为特定设备免定位，可在资源编辑页单独覆盖。")}
          </p>
        ) : (
          <div className="grid gap-2">
            {overriddenResources.map((resource) => {
              const ov = resource.locationOverride!;
              const mode = normalizeResourceLocationMode(ov.mode);
              const pinned = ov.beaconNodeId ? beaconById.get(ov.beaconNodeId) : null;
              const rssiLabel = rssiPresetLabel(ov.rssiThreshold);
              const summaryParts =
                mode === "none"
                  ? [t("不校验位置")]
                  : [
                      t("强制校验"),
                      ...(pinned
                        ? [`${pinned.nodeName} #${pinned.beaconId}`]
                        : ov.beaconNodeId
                          ? [t("指定信标")]
                          : [t("自动信标/GPS")]),
                      ...(rssiLabel ? [t(rssiLabel)] : []),
                    ];
              return (
                <div
                  key={resource.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/10 bg-ink/[0.02] px-3.5 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{resource.name}</span>
                    <span className="ml-2 text-xs text-ink/55">{summaryParts.join(" · ")}</span>
                  </div>
                  <button
                    type="button"
                    className={`${buttonQuiet} px-2.5 py-1 text-xs`}
                    disabled={clearingId === resource.id}
                    onClick={() => void resetResourceOverride(resource)}
                  >
                    {t(clearingId === resource.id ? "处理中…" : "恢复跟随店铺")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
