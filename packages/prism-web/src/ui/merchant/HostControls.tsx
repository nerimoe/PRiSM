import { useCallback, useEffect, useState } from "react";
import { Camera, Keyboard, Play, Power, RefreshCw, RotateCcw, Send, X } from "lucide-react";
import { Api, type HostCommandInput, type HostStatus, type Resource } from "../../api";
import { useI18n } from "../../i18n";
import { button, buttonQuiet, input, primary } from "./shared";

/**
 * Remote host operations for a resource bound to a PRiSM Launcher node:
 * game switching, key presses, text entry, live screenshots, and reboot/shutdown.
 */
export function HostControls({
  device,
  disabled,
  onChanged,
}: {
  device: Resource;
  disabled: boolean;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [textInput, setTextInput] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [screenshot, setScreenshot] = useState<{ src: string; at: string } | null>(null);
  const [confirmPower, setConfirmPower] = useState<"reboot" | "shutdown" | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await Api.hostStatus(device.id);
      setStatus(next);
    } catch {
      // Keep last known status.
    } finally {
      setLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const programs = status?.config?.programs ?? device.host?.programs ?? [];
  const online = status?.online;
  const offline = online === false;

  async function run(label: string, command: HostCommandInput) {
    if (busy) return;
    setBusy(label);
    setError("");
    setMessage("");
    setConfirmPower(null);
    try {
      const res = await Api.hostCommand(device.id, command);
      if (!res.ok) {
        setError(res.error ?? t("指令执行失败"));
      } else if (command.action === "screenshot") {
        const mime = typeof res.result?.mime === "string" ? res.result.mime : "image/jpeg";
        const data = typeof res.result?.data === "string" ? res.result.data : "";
        if (data) {
          setScreenshot({
            src: `data:${mime};base64,${data}`,
            at: new Date().toLocaleTimeString(),
          });
          setMessage(t("截屏已更新"));
        } else {
          setError(t("未收到截屏数据"));
        }
      } else {
        setMessage(t("已发送"));
        if (command.action === "text") setTextInput("");
        if (command.action === "switch") void loadStatus();
      }
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("指令执行失败"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
              online === true
                ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
                : online === false
                  ? "bg-coral/10 text-coral"
                  : "bg-ink/[0.06] text-ink/55"
            }`}
          >
            {t(online === true ? "Launcher 在线" : online === false ? "Launcher 离线" : "状态读取中…")}
          </span>
          {status?.version && <span className="tabular-nums text-ink/50">{`v${status.version}`}</span>}
          {status?.program && (
            <span className="font-medium text-ink/75">{t("当前：{name}", { name: status.program })}</span>
          )}
        </div>
        <button
          type="button"
          className={`${buttonQuiet} min-h-8 px-2 text-xs`}
          disabled={loading}
          onClick={() => void loadStatus()}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          {t("刷新")}
        </button>
      </div>

      {/* Game / program switching */}
      {programs.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs text-ink/55">{t("切换游戏 / 程序")}</span>
          <div className="flex flex-wrap gap-2">
            {programs.map((prog) => {
              const active = status?.program === prog.name;
              return (
                <button
                  key={prog.name}
                  type="button"
                  className={`${active ? primary : button} min-h-9 px-3 text-xs`}
                  disabled={disabled || offline || !!busy}
                  onClick={() => void run(`switch:${prog.name}`, { action: "switch", name: prog.name })}
                >
                  <Play size={13} aria-hidden="true" />
                  {prog.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Ad-hoc key press */}
      <div className="grid gap-1.5">
        <span className="text-xs text-ink/55">{t("临时按键")}</span>
        <div className="flex items-center gap-2">
          <input
            className={`${input} min-h-9 min-w-0 flex-1 font-mono text-xs`}
            placeholder={t("键名或 VK 码，如 F1、Enter、Space")}
            maxLength={16}
            value={customKey}
            disabled={disabled || offline}
            onChange={(e) => setCustomKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customKey.trim()) {
                e.preventDefault();
                void run("key:custom", { action: "key", key: customKey.trim() });
              }
            }}
          />
          <button
            type="button"
            className={`${button} min-h-9 shrink-0 px-3 text-xs`}
            disabled={disabled || offline || !customKey.trim() || !!busy}
            onClick={() => void run("key:custom", { action: "key", key: customKey.trim() })}
          >
            <Keyboard size={14} aria-hidden="true" />
            {t("按键")}
          </button>
        </div>
      </div>

      {/* Text input (supports Chinese / Unicode) */}
      <div className="grid gap-1.5">
        <span className="text-xs text-ink/55">{t("发送文字输入（支持中文）")}</span>
        <div className="flex items-center gap-2">
          <input
            className={`${input} min-h-9 min-w-0 flex-1 text-xs`}
            placeholder={t("输入要发送到当前窗口的文字")}
            maxLength={256}
            value={textInput}
            disabled={disabled || offline}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && textInput.length > 0) {
                e.preventDefault();
                void run("text", { action: "text", text: textInput });
              }
            }}
          />
          <button
            type="button"
            className={`${button} min-h-9 shrink-0 px-3 text-xs`}
            disabled={disabled || offline || !textInput.length || !!busy}
            onClick={() => void run("text", { action: "text", text: textInput })}
          >
            <Send size={14} aria-hidden="true" />
            {t("发送")}
          </button>
        </div>
      </div>

      {/* Screenshot + power actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${button} min-h-9 px-3 text-xs`}
          disabled={disabled || offline || !!busy}
          onClick={() => void run("screenshot", { action: "screenshot" })}
        >
          <Camera size={14} aria-hidden="true" />
          {busy === "screenshot" ? t("截屏中…") : t("截取画面")}
        </button>

        {confirmPower === "reboot" ? (
          <span className="inline-flex items-center gap-1.5 rounded-xl border border-coral/30 bg-coral/[0.06] px-2.5 py-1 text-xs">
            <span className="font-medium text-coral">{t("确认重启 Windows？")}</span>
            <button
              type="button"
              className="rounded-lg bg-coral px-2.5 py-1 font-medium text-white"
              disabled={!!busy}
              onClick={() => void run("reboot", { action: "reboot" })}
            >
              {t("确认")}
            </button>
            <button type="button" className="text-ink/60 hover:text-ink" onClick={() => setConfirmPower(null)}>
              {t("取消")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={`${button} min-h-9 px-3 text-xs text-coral hover:bg-coral/5`}
            disabled={disabled || offline || !!busy}
            onClick={() => setConfirmPower("reboot")}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t("重启主机")}
          </button>
        )}

        {confirmPower === "shutdown" ? (
          <span className="inline-flex items-center gap-1.5 rounded-xl border border-coral/30 bg-coral/[0.06] px-2.5 py-1 text-xs">
            <span className="font-medium text-coral">{t("确认关闭 Windows？")}</span>
            <button
              type="button"
              className="rounded-lg bg-coral px-2.5 py-1 font-medium text-white"
              disabled={!!busy}
              onClick={() => void run("shutdown", { action: "shutdown" })}
            >
              {t("确认")}
            </button>
            <button type="button" className="text-ink/60 hover:text-ink" onClick={() => setConfirmPower(null)}>
              {t("取消")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={`${button} min-h-9 px-3 text-xs text-coral hover:bg-coral/5`}
            disabled={disabled || offline || !!busy}
            onClick={() => setConfirmPower("shutdown")}
          >
            <Power size={14} aria-hidden="true" />
            {t("关闭主机")}
          </button>
        )}
      </div>

      {screenshot && (
        <div className="grid gap-1.5 rounded-xl border border-ink/10 bg-ink/[0.02] p-2">
          <div className="flex items-center justify-between text-xs text-ink/55">
            <span>{t("截屏时间：{time}", { time: screenshot.at })}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-ink/50 hover:text-ink"
              onClick={() => setScreenshot(null)}
            >
              <X size={13} aria-hidden="true" />
              {t("收起")}
            </button>
          </div>
          <a href={screenshot.src} target="_blank" rel="noreferrer" title={t("点击查看原图")}>
            <img
              src={screenshot.src}
              alt={t("{name} 截屏", { name: device.name })}
              className="max-h-72 w-full rounded-lg bg-black/80 object-contain"
            />
          </a>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-coral">{error}</p>}
      {message && !error && <p role="status" className="text-xs text-mint">{message}</p>}
    </div>
  );
}
