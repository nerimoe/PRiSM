import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";

export function ShopHeroEditor({ value, onChange, onBusy }: {
  value: string | null;
  onChange: (value: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t, errorText } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    onBusy(reading || source !== null);
    return () => onBusy(false);
  }, [reading, source, onBusy]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!source || !context) return;
    const width = Math.min(source.naturalWidth, source.naturalHeight * 1.5) / zoom;
    const height = width / 1.5;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 1200, 800);
    context.drawImage(source, (source.naturalWidth - width) * x / 100,
      (source.naturalHeight - height) * y / 100, width, height, 0, 0, 1200, 800);
  }, [source, zoom, x, y]);

  const select = async (file: File) => {
    setError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
      setError("请选择 8 MB 以内的 JPG、PNG 或 WebP 图片");
      return;
    }
    setReading(true);
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      setZoom(1); setX(50); setY(50); setSource(image);
    } catch {
      setError("无法读取这张图片，请换一张试试");
    } finally {
      URL.revokeObjectURL(url);
      setReading(false);
    }
  };

  const save = () => {
    if (!canvas.current) return;
    let data = "";
    for (const quality of [0.88, 0.78, 0.65, 0.5]) {
      data = canvas.current.toDataURL("image/webp", quality);
      if (!data.startsWith("data:image/webp")) data = canvas.current.toDataURL("image/jpeg", quality);
      if (data.length <= 700_000) break;
    }
    if (data.length > 700_000) {
      setError("封面压缩后仍然过大，请换一张图片");
      return;
    }
    onChange(data); setSource(null); setError(null);
  };

  return (
    <fieldset className="hero-editor grid min-w-0 gap-3">
      <legend className="mb-2 text-base font-semibold">{t("店铺封面")}</legend>
      <p className="text-sm text-ink/70">{t("用于机台登录页展示店铺环境、品牌或游戏氛围。建议使用横向照片或插画，避免二维码、价格表和大段文字。推荐尺寸 1800×1200。")}</p>
      {source ? <>
        <canvas ref={canvas} width={1200} height={800} className="aspect-[3/2] w-full rounded-2xl" aria-label={t("3:2 封面裁剪预览")} />
        {source.naturalWidth < 1200 || source.naturalHeight < 800 ? <p className="text-sm text-ink/70">{t("原图较小，建议至少使用 1200×800 的图片。")}</p> : null}
        <label className="grid gap-1 text-sm">{t("缩放")}<input type="range" min={1} max={3} step={0.01} value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
        <label className="grid gap-1 text-sm">{t("水平位置")}<input type="range" min={0} max={100} value={x} onChange={e => setX(Number(e.target.value))} /></label>
        <label className="grid gap-1 text-sm">{t("垂直位置")}<input type="range" min={0} max={100} value={y} onChange={e => setY(Number(e.target.value))} /></label>
        <div className="flex gap-3">
          <button type="button" className="session-action primary flex-1" onClick={save}>{t("使用此封面")}</button>
          <button type="button" className="session-action flex-1" onClick={() => { setSource(null); setError(null); }}>{t("取消裁剪")}</button>
        </div>
      </> : <>
        {value && <img src={value} alt={t("店铺封面预览")} className="aspect-[3/2] w-full rounded-2xl object-cover" />}
        <label className="grid gap-2 text-sm font-medium">{value ? t("更换封面") : t("上传封面")}
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={reading} onChange={e => {
            const file = e.currentTarget.files?.[0]; e.currentTarget.value = "";
            if (file) void select(file);
          }} />
        </label>
        {value && <button type="button" className="focus-ring justify-self-start rounded-xl px-4 py-3 text-coral" onClick={() => onChange(null)}>{t("移除封面")}</button>}
      </>}
      {error && <p role="alert" className="text-sm text-coral">{errorText(error)}</p>}
    </fieldset>
  );
}
