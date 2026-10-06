import { useState, type ChangeEvent } from "react";
import { api, ApiError } from "../../api";
import { useI18n } from "../../i18n";
import { button, primary, input, Field, Modal, useMerchant } from "./shared";

type Preview = {
  canImport: boolean; fingerprint: string; scope: "business" | "configuration";
  source: { name: string; publicId: string; origin?: string }; counts: Record<string, number>;
  warnings: string[]; errors: string[];
};
const labels: Record<string, string> = {
  pricing_effects: "计费效果", asset_definitions: "资产定义", pricing_configs: "计费方案", presents: "礼物", business_items: "商品",
  pricing_config_versions: "历史规则版本", pricing_releases: "计费发布版本", pricing_release_heads: "当前计费发布版本",
  players: "玩家", player_identities: "平台身份", cashier_profiles: "前台玩家", sessions: "计费会话",
  session_pricing_releases: "会话计费版本", asset_holdings: "资产余额", asset_transactions: "资产交易", asset_ledger_entries: "资产流水",
  redeem_codes: "兑换码", redeem_records: "兑换记录", player_checkouts: "结账记录", checkout_timelines: "账单时间轴",
  settlements: "会话账单", settlement_charge_items: "收费明细", settlement_adjustments: "费用调整",
  pricing_history_entries: "收费历史", pricing_cap_history_entries: "封顶历史", business_item_orders: "商品订单", cashier_payments: "前台收款",
};
const maxBytes = 10 * 1024 * 1024;
export function ShopDataTransfer() {
  const { shopCode } = useMerchant();
  const { t, errorText } = useI18n();
  const [scope, setScope] = useState<"business" | "configuration">("business");
  const [backup, setBackup] = useState<unknown>();
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [operationId, setOperationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const path = `/api/v1/shops/${encodeURIComponent(shopCode)}/data`;
  function failed(value: unknown) {
    setError(errorText(value instanceof Error ? value.message : "操作失败，请稍后重试"));
  }
  async function download() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${path}/export?scope=${scope}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error?.message ?? "操作失败，请稍后重试");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `prism-${shopCode}-${scope}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (value) { failed(value); }
    finally { setBusy(false); }
  }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setBackup(undefined); setPreview(undefined); setFilename(file?.name ?? ""); setError(""); setSuccess(false);
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > maxBytes) throw new Error("备份文件超过 10 MiB 限制");
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error("请选择有效的 JSON 备份文件"); }
      setBackup(parsed); setOperationId(crypto.randomUUID());
    } catch (value) { failed(value); }
    finally { setBusy(false); }
  }
  async function preflight() {
    setBusy(true); setError(""); setPreview(undefined);
    try {
      setPreview(await api<Preview>(`${path}/import/preview`, { method: "POST", body: JSON.stringify({ backup }) }));
    } catch (value) { failed(value); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview?.canImport) return;
    setBusy(true); setError("");
    try {
      await api(`${path}/import/apply`, { method: "POST", body: JSON.stringify({ backup, fingerprint: preview.fingerprint, operationId }) });
      setConfirm(false); setSuccess(true); setBackup(undefined); setPreview(undefined);
      window.dispatchEvent(new Event("prism-shop-settings"));
    } catch (value) {
      setConfirm(false);
      if (value instanceof ApiError && ["IMPORT_TARGET_CHANGED", "IMPORT_NOT_READY"].includes(value.code ?? "")) setPreview(undefined);
      failed(value);
    } finally { setBusy(false); }
  }
  return (
    <div className="grid gap-5">
      <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
        <h4 className="font-semibold">{t("导出 JSON 备份")}</h4>
        <p className="text-sm leading-relaxed text-ink/60">{t("用于数据备份，以及 beta 与正式版之间的店铺业务数据迁移。金额和时间保留原值。")}</p>
        <p className="text-sm leading-relaxed text-ink/60">{t("跨环境迁移时，请先停止旧环境营业，核对导入结果后再在新环境营业，避免两边同时计费。")}</p>
        <Field label="导出范围">
          <select className={input} value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}>
            <option value="business">{t("业务备份（玩家、余额、账单和配置）")}</option>
            <option value="configuration">{t("仅店铺配置（不含玩家和账单）")}</option>
          </select>
        </Field>
        <button className={`${button} justify-self-start`} disabled={busy} onClick={download}>{t("下载 JSON 文件")}</button>
      </section>
      <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
        <h4 className="font-semibold">{t("从 JSON 导入")}</h4>
        <p className="text-sm leading-relaxed text-ink/60">{t("导入到空店铺，先预检再确认。不会覆盖已有玩家、余额或账单；目标店铺的名称、位置、时区和管理员保持不变。")}</p>
        <p className="text-sm leading-relaxed text-ink/60">{t("备份不含网页登录账号关联、登录凭据、Bot 凭据或设备连接；导入后需重新绑定和配置设备。文件包含玩家身份和财务数据，请妥善保管。")}</p>
        <Field label="JSON 备份文件">
          <input className={input} type="file" accept=".json,application/json" disabled={busy} onChange={selectFile} />
        </Field>
        <p className="text-xs text-ink/60">{t("支持当前版本 PRiSM 导出的 JSON，最大 10 MiB。")}</p>
        <button className={`${button} justify-self-start`} disabled={busy || !backup || success} onClick={preflight}>{t(busy ? "处理中…" : "预检导入")}</button>
        {preview && (
          <div className="grid gap-3 rounded-lg border border-ink/10 p-4">
            <p className="font-medium">{t("来源店铺")}: {preview.source.name} · {preview.source.publicId}</p>
            {preview.source.origin && <p className="break-all text-xs text-ink/60">{t("来源环境")}: {preview.source.origin}</p>}
            <p className="break-all text-xs text-ink/60">{filename}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {Object.entries(preview.counts).filter(([, count]) => count > 0).map(([table, count]) => (
                <div key={table} className="flex justify-between gap-2"><dt>{t(labels[table] ?? table)}</dt><dd className="tabular-nums">{count}</dd></div>
              ))}
            </dl>
            {preview.errors.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-rose-600">{preview.errors.map((message, index) => <li key={index}>{t(message)}</li>)}</ul>}
            <p role="status" className="text-sm">{t(preview.canImport ? "预检通过，可以确认导入。" : "预检未通过，请处理上述问题后重试。")}</p>
            {preview.canImport && <button className={`${primary} justify-self-start`} disabled={busy} onClick={() => setConfirm(true)}>{t("确认导入")}</button>}
          </div>
        )}
      </section>
      {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
      {success && <p role="status" className="text-sm text-mint">{t("导入完成，请检查计费设置并重新配置设备与接入凭据。")}</p>}
      {confirm && preview && <Modal title="确认导入店铺数据" close={() => setConfirm(false)} dismissDisabled={busy}>
        <div className="grid gap-4 p-5">
          <p>{t("将来源店铺的业务数据导入当前空店铺。")}</p>
          <p className="font-medium">{preview.source.name} · {preview.source.publicId}</p>
          <ul className="list-disc space-y-2 pl-5 text-sm text-ink/60">{preview.warnings.map(message => <li key={message}>{t(message)}</li>)}</ul>
          <button className={primary} disabled={busy} onClick={apply}>{t(busy ? "处理中…" : "开始导入")}</button>
        </div>
      </Modal>}
    </div>
  );
}
