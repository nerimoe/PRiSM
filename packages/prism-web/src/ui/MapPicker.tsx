import { useI18n } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, TileLayer, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import { Loader2, LocateFixed } from "lucide-react";
import { gcj02ToWgs84, outOfChina, wgs84ToGcj02 } from "../coord";

type MapPickerProps = {
  latitude: number | null;
  longitude: number | null;
  onChange: (latitude: number, longitude: number) => void;
};

type MapProvider = "amap" | "osm";

const chinaDefaultCenter: [number, number] = [31.2304, 121.4737]; // Shanghai
const worldDefaultCenter: [number, number] = [35.681236, 139.767125]; // Tokyo

export function MapPicker({ latitude, longitude, onChange }: MapPickerProps) {
  const { t, errorText, locale } = useI18n();
  const [provider, setProvider] = useState<MapProvider>(() => {
    if (latitude !== null && longitude !== null && outOfChina(latitude, longitude)) {
      return "osm";
    }
    return "amap";
  });

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);

  const initialCenter = useMemo<[number, number]>(() => {
    if (latitude !== null && longitude !== null) {
      return provider === "amap" ? wgs84ToGcj02(latitude, longitude) : [latitude, longitude];
    }
    return provider === "amap" ? chinaDefaultCenter : worldDefaultCenter;
  }, []);

  const markerCenter = useMemo<[number, number] | null>(() => {
    if (latitude === null || longitude === null) return null;
    return provider === "amap" ? wgs84ToGcj02(latitude, longitude) : [latitude, longitude];
  }, [latitude, longitude, provider]);

  const handleLocate = () => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setLocateError("当前浏览器不支持定位或未在安全环境(HTTPS)下运行");
      return;
    }

    setLocating(true);
    setLocateError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const wgsLat = roundCoord(pos.coords.latitude);
        const wgsLng = roundCoord(pos.coords.longitude);
        onChange(wgsLat, wgsLng);

        const inChina = !outOfChina(wgsLat, wgsLng);
        const nextProvider = inChina ? "amap" : provider;
        if (inChina && provider !== "amap") {
          setProvider("amap");
        }

        const target: [number, number] = nextProvider === "amap" ? wgs84ToGcj02(wgsLat, wgsLng) : [wgsLat, wgsLng];
        setFlyTarget(target);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        if (err.code === 1) {
          setLocateError("定位权限被拒绝，请在浏览器允许访问位置信息");
        } else if (err.code === 3) {
          setLocateError("定位请求超时，请稍后重试或手动点击地图选点");
        } else {
          setLocateError("无法获取当前位置，请在地图上手动选点");
        }
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  };

  const handleSwitchProvider = (next: MapProvider) => {
    if (next === provider) return;
    setProvider(next);
    if (latitude !== null && longitude !== null) {
      const target: [number, number] = next === "amap" ? wgs84ToGcj02(latitude, longitude) : [latitude, longitude];
      setFlyTarget(target);
    }
  };

  const handleCenterMarker = () => {
    if (latitude !== null && longitude !== null) {
      const target: [number, number] = provider === "amap" ? wgs84ToGcj02(latitude, longitude) : [latitude, longitude];
      setFlyTarget(target);
    }
  };

  return (
    <div className="shop-map overflow-hidden rounded border border-ink/10 bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 bg-panel/80 px-3 py-2 text-xs">
        <div className="inline-flex rounded-md border border-ink/10 bg-surface p-0.5">
          <button
            type="button"
            onClick={() => handleSwitchProvider("amap")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              provider === "amap"
                ? "bg-ink text-canvas shadow-xs"
                : "text-ink/70 hover:text-ink"
            }`}
          >
            {t("高德 (国内)")}</button>
          <button
            type="button"
            onClick={() => handleSwitchProvider("osm")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              provider === "osm"
                ? "bg-ink text-canvas shadow-xs"
                : "text-ink/70 hover:text-ink"
            }`}
          >
            {t("Carto (国际)")}</button>
        </div>

        <div className="flex items-center gap-1.5">
          {latitude !== null && longitude !== null && (
            <button
              type="button"
              onClick={handleCenterMarker}
              className="focus-ring inline-flex items-center rounded border border-ink/15 bg-surface px-2 py-1 text-ink/70 hover:bg-ink/5 hover:text-ink"
              title={t("将地图视角移动到当前标记点")}
            >
              {t("居中标记")}</button>
          )}
          <button
            type="button"
            onClick={handleLocate}
            disabled={locating}
            className="focus-ring inline-flex items-center gap-1.5 rounded border border-ink/15 bg-surface px-2.5 py-1 font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
            title={t("获取当前 GPS 定位并填入")}
          >
            {locating ? <Loader2 size={13} className="animate-spin" /> : <LocateFixed size={13} />}
            <span>{locating ? t("定位中...") : t("定位当前位置")}</span>
          </button>
        </div>
      </div>

      {locateError && (
        <div className="flex items-center justify-between border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          <span>{errorText(locateError)}</span>
          <button
            type="button"
            onClick={() => setLocateError(null)}
            className="ml-2 font-bold opacity-60 hover:opacity-100"
            title={t("关闭提示")}
          >
            &times;
          </button>
        </div>
      )}

      <MapContainer
        center={initialCenter}
        zoom={latitude !== null && longitude !== null ? 16 : 14}
        scrollWheelZoom={true}
        zoomControl={false}
        className="h-64 w-full"
      >
        <ZoomControl key={locale} zoomInTitle={t("放大")} zoomOutTitle={t("缩小")} />
        {provider === "amap" ? (
          <TileLayer
            key="amap"
            attribution={`&copy; <a href="https://www.amap.com/" target="_blank" rel="noreferrer">${t("高德地图")}</a>`}
            url="https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}"
            subdomains={["1", "2", "3", "4"]}
            maxZoom={18}
          />
        ) : (
          <TileLayer
            key="osm"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            subdomains={["a", "b", "c", "d"]}
            maxZoom={19}
          />
        )}

        <MapController flyTarget={flyTarget} onFlyDone={() => setFlyTarget(null)} />
        <ClickHandler provider={provider} onChange={onChange} />

        {markerCenter && (
          <CircleMarker
            center={markerCenter}
            radius={9}
            pathOptions={{ color: "#107c72", fillColor: "#107c72", fillOpacity: 0.9 }}
          />
        )}
      </MapContainer>
    </div>
  );
}

function MapController({
  flyTarget,
  onFlyDone,
}: {
  flyTarget: [number, number] | null;
  onFlyDone: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (flyTarget) {
      map.flyTo(flyTarget, 16, { duration: 1 });
      onFlyDone();
    }
  }, [flyTarget, map, onFlyDone]);

  return null;
}

function ClickHandler({
  provider,
  onChange,
}: {
  provider: MapProvider;
  onChange: (latitude: number, longitude: number) => void;
}) {
  useMapEvents({
    click(event) {
      const { lat, lng } = event.latlng;
      if (provider === "amap") {
        const [wgsLat, wgsLng] = gcj02ToWgs84(lat, lng);
        onChange(roundCoord(wgsLat), roundCoord(wgsLng));
      } else {
        onChange(roundCoord(lat), roundCoord(lng));
      }
    },
  });
  return null;
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
