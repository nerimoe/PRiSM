import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Camera,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Gamepad2,
  Keyboard,
  Monitor,
  Pencil,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Api,
  type HostCommandInput,
  type HostFsEntry,
  type HostPowerShellResult,
  type HostStatus,
  type Resource,
} from "../../api";
import { useI18n } from "../../i18n";
import { button, buttonQuiet, input, primary } from "./shared";

const MAX_UPLOAD_BYTES = 512 * 1024;

type HostTab = "control" | "files" | "terminal";

function parentDirOf(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const prefix = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(prefix)) return `${prefix}\\`;
  return prefix || null;
}

function joinChildPath(dir: string, name: string): string {
  const clean = dir.trim().replace(/[\\/]+$/, "");
  const sep = clean.includes("/") && !clean.includes("\\") ? "/" : "\\";
  return `${clean}${sep}${name.trim()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Remote host operations for a resource bound to a PRiSM Launcher node:
 * structured into a persistent status/update bar and three focused tabs
 * (Control & Screen, Files, and PowerShell).
 */
export function HostControls({
  device,
  disabled,
  onChanged,
  embedded = false,
}: {
  device: Resource;
  disabled: boolean;
  onChanged?: () => void;
  /** True when mounted edge-to-edge inside the multi-pane ResourceActionsModal. */
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<HostTab>("control");
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [textInput, setTextInput] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [screenshot, setScreenshot] = useState<{ src: string; at: string } | null>(null);
  const [confirmPower, setConfirmPower] = useState<"reboot" | "shutdown" | null>(null);

  // File manager state
  const allowedRoots = status?.config?.allowedRoots ?? [];
  const defaultRoot = allowedRoots[0] ?? "C:\\";
  const [fsPath, setFsPath] = useState("");
  const [fsEntries, setFsEntries] = useState<HostFsEntry[]>([]);
  const [fsLoaded, setFsLoaded] = useState(false);
  const [fsTruncated, setFsTruncated] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // PowerShell terminal state
  const [psScript, setPsScript] = useState("");
  const [psCwd, setPsCwd] = useState("");
  const [psTimeoutMs, setPsTimeoutMs] = useState(15_000);
  const [psShell, setPsShell] = useState<"powershell" | "pwsh">("powershell");
  const [psResult, setPsResult] = useState<HostPowerShellResult | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await Api.hostStatus(device.id);
      setStatus(next);
      setFsPath((prev) => prev || next.config?.allowedRoots?.[0] || "C:\\");
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

  async function run(label: string, command: HostCommandInput): Promise<Record<string, unknown> | null> {
    if (busy) return null;
    setBusy(label);
    setError("");
    setMessage("");
    setConfirmPower(null);
    try {
      const res = await Api.hostCommand(device.id, command);
      if (!res.ok) {
        setError(res.error ?? t("指令执行失败"));
        return null;
      }
      if (command.action === "update.check") {
        const updateStatus = res.result?.status;
        setMessage(
          t(
            updateStatus === "pending"
              ? "新版已下载，下次启动生效"
              : updateStatus === "checking"
                ? "正在后台检查更新，请稍后再查"
                : "已是最新版本",
          ),
        );
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
      } else if (!command.action.startsWith("fs.") && command.action !== "powershell") {
        setMessage(t("已发送"));
        if (command.action === "text") setTextInput("");
        if (command.action === "switch") void loadStatus();
      }
      onChanged?.();
      return res.result ?? {};
    } catch (e) {
      setError(e instanceof Error ? e.message : t("指令执行失败"));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function listDirectory(targetPath: string) {
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    const result = await run("fs.list", { action: "fs.list", path: trimmed });
    if (!result) return;
    const resolved = typeof result.path === "string" ? result.path : trimmed;
    setFsPath(resolved);
    setFsEntries(Array.isArray(result.entries) ? (result.entries as HostFsEntry[]) : []);
    setFsLoaded(true);
    setFsTruncated(result.truncated === true);
    setConfirmDeletePath(null);
    setRenaming(null);
  }

  async function openTextFile(targetPath: string) {
    const result = await run("fs.read", { action: "fs.read", path: targetPath, encoding: "utf8" });
    if (!result) return;
    setOpenFile({
      path: typeof result.path === "string" ? result.path : targetPath,
      content: typeof result.content === "string" ? result.content : "",
      dirty: false,
    });
  }

  async function downloadFile(targetPath: string, filename: string) {
    const result = await run("fs.download", { action: "fs.read", path: targetPath, encoding: "base64" });
    if (!result || typeof result.content !== "string") return;
    const bin = atob(result.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage(t("文件已下载"));
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t("文件大小不能超过 512 KB"));
      return;
    }
    const dir = fsPath.trim() || defaultRoot;
    const buf = new Uint8Array(await file.arrayBuffer());
    const targetPath = joinChildPath(dir, file.name);
    const res = await run("fs.upload", {
      action: "fs.write",
      path: targetPath,
      content: bytesToBase64(buf),
      encoding: "base64",
    });
    if (res) {
      setMessage(t("文件已上传"));
      await listDirectory(dir);
    }
  }

  async function saveOpenFile() {
    if (!openFile) return;
    const res = await run("fs.write", {
      action: "fs.write",
      path: openFile.path,
      content: openFile.content,
      encoding: "utf8",
    });
    if (res) {
      setOpenFile({ ...openFile, dirty: false });
      setMessage(t("文件已保存"));
      if (fsPath.trim()) await listDirectory(fsPath);
    }
  }

  async function createDirectory() {
    const name = newDirName.trim();
    const dir = fsPath.trim() || defaultRoot;
    if (!name) return;
    const res = await run("fs.mkdir", {
      action: "fs.mkdir",
      path: joinChildPath(dir, name),
      recursive: true,
    });
    if (res) {
      setNewDirName("");
      setMessage(t("目录已创建"));
      await listDirectory(dir);
    }
  }

  async function confirmRename() {
    if (!renaming || !renaming.to.trim()) return;
    const res = await run("fs.rename", {
      action: "fs.rename",
      from: renaming.from,
      to: renaming.to.trim(),
      overwrite: false,
    });
    if (res) {
      setRenaming(null);
      setMessage(t("已重命名"));
      if (fsPath.trim()) await listDirectory(fsPath);
    }
  }

  async function deleteEntry(entry: HostFsEntry) {
    const res = await run("fs.delete", {
      action: "fs.delete",
      path: entry.path,
      recursive: entry.isDir,
    });
    if (res) {
      setConfirmDeletePath(null);
      if (openFile?.path === entry.path) setOpenFile(null);
      setMessage(t("已删除"));
      if (fsPath.trim()) await listDirectory(fsPath);
    }
  }

  async function executePowerShell() {
    const script = psScript.trim();
    if (!script) return;
    const result = await run("powershell", {
      action: "powershell",
      script,
      ...(psCwd.trim() ? { cwd: psCwd.trim() } : {}),
      timeoutMs: psTimeoutMs,
      shell: psShell,
    });
    if (result) {
      setPsResult({
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        timedOut: result.timedOut === true,
        durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
        stdoutTruncated: result.stdoutTruncated === true,
        stderrTruncated: result.stderrTruncated === true,
      });
    }
  }

  const parentDir = parentDirOf(fsPath);
  const padX = embedded ? "px-5" : "px-4";
  const bodyPad = embedded ? "p-5 pt-3.5" : "p-4 pt-3.5";

  return (
    <div className={embedded ? "flex min-w-0 flex-col" : "flex min-w-0 flex-col rounded-xl border border-ink/10 bg-panel"}>
      {/* Persistent top status + utility bar */}
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-ink/[0.08] py-3 ${padX}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Monitor size={15} className="text-ink/50" aria-hidden="true" />
            {t("PRiSM Launcher")}
          </span>
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
          {status?.version && (
            <span className="rounded-md bg-ink/[0.05] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink/60">
              {`v${status.version}`}
            </span>
          )}
          {status?.program && (
            <span className="truncate font-medium text-ink/75">{t("当前：{name}", { name: status.program })}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={`${buttonQuiet} min-h-8 border border-ink/10 px-2.5 text-xs`}
            disabled={disabled || offline || !!busy}
            onClick={() => void run("update.check", { action: "update.check" })}
          >
            <RefreshCw size={13} className={busy === "update.check" ? "animate-spin" : ""} aria-hidden="true" />
            {busy === "update.check" ? t("检查更新中…") : t("检查更新")}
          </button>
          <button
            type="button"
            className={`${buttonQuiet} min-h-8 px-2.5 text-xs`}
            disabled={loading}
            onClick={() => void loadStatus()}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            {t("刷新")}
          </button>
        </div>
      </div>

      {/* Sub-tab switcher */}
      <div className={`pt-3 ${padX}`}>
        <div
          className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-ink/10 bg-ink/[0.03] p-1"
          role="tablist"
          aria-label={t("启动器功能")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "control"}
            className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
              tab === "control" ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"
            }`}
            onClick={() => setTab("control")}
          >
            <Gamepad2 size={14} aria-hidden="true" />
            {t("控制与画面")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
              tab === "files" ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"
            }`}
            onClick={() => setTab("files")}
          >
            <Folder size={14} aria-hidden="true" />
            {t("文件管理")}
            {openFile?.dirty && (
              <span className="size-1.5 rounded-full bg-amber-500" aria-label={t("未保存")} />
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "terminal"}
            className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
              tab === "terminal" ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"
            }`}
            onClick={() => setTab("terminal")}
          >
            <Terminal size={14} aria-hidden="true" />
            {t("PowerShell")}
            {psResult && (
              <span
                className={`size-1.5 rounded-full ${psResult.exitCode === 0 ? "bg-mint" : "bg-coral"}`}
                aria-hidden="true"
              />
            )}
          </button>
        </div>
      </div>

      {/* Persistent feedback strip */}
      {(error || message) && (
        <div className={`pt-2.5 ${padX}`}>
          {error ? (
            <p role="alert" className="rounded-lg border border-coral/25 bg-coral/[0.06] px-3 py-1.5 text-xs text-coral">
              {error}
            </p>
          ) : (
            <p role="status" className="rounded-lg border border-mint/25 bg-mint/[0.06] px-3 py-1.5 text-xs text-mint">
              {message}
            </p>
          )}
        </div>
      )}

      {/* Tab 1: Control & Screen */}
      {tab === "control" && (
        <div className={`grid gap-3.5 ${bodyPad}`}>
          {programs.length > 0 && (
            <section className="grid gap-2 rounded-xl border border-ink/10 bg-panel p-3.5">
              <span className="text-xs font-medium text-ink/65">{t("切换游戏 / 程序")}</span>
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
            </section>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <section className="grid gap-2 rounded-xl border border-ink/10 bg-panel p-3.5">
              <span className="text-xs font-medium text-ink/65">{t("临时按键")}</span>
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
            </section>

            <section className="grid gap-2 rounded-xl border border-ink/10 bg-panel p-3.5">
              <span className="text-xs font-medium text-ink/65">{t("发送文字输入（支持中文）")}</span>
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
            </section>
          </div>

          {/* Remote screen preview */}
          <section className="grid gap-2.5 rounded-xl border border-ink/10 bg-ink/[0.02] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <Camera size={14} className="text-ink/50" aria-hidden="true" />
                <span className="font-medium text-ink/75">{t("远程画面")}</span>
                {screenshot && (
                  <span className="tabular-nums text-ink/50">
                    {t("截屏时间：{time}", { time: screenshot.at })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {screenshot && (
                  <>
                    <a
                      href={screenshot.src}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-ink/60 hover:text-ink hover:underline"
                    >
                      {t("查看原图")}
                    </a>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-ink/55 hover:text-ink"
                      onClick={() => setScreenshot(null)}
                    >
                      <X size={13} aria-hidden="true" />
                      {t("收起")}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`${button} min-h-8 px-3 text-xs`}
                  disabled={disabled || offline || !!busy}
                  onClick={() => void run("screenshot", { action: "screenshot" })}
                >
                  <Camera size={13} aria-hidden="true" />
                  {busy === "screenshot" ? t("截屏中…") : t("截取画面")}
                </button>
              </div>
            </div>
            {screenshot ? (
              <a href={screenshot.src} target="_blank" rel="noreferrer" title={t("点击查看原图")}>
                <img
                  src={screenshot.src}
                  alt={t("{name} 截屏", { name: device.name })}
                  className="max-h-[22rem] w-full rounded-lg bg-black/85 object-contain"
                />
              </a>
            ) : (
              <p className="text-xs text-ink/45">
                {t("点击「截取画面」获取当前机台桌面画面")}
              </p>
            )}
          </section>

          {/* Host power danger bar */}
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-coral/20 bg-coral/[0.03] px-3.5 py-2.5">
            <span className="text-xs font-medium text-ink/70">{t("主机电源")}</span>
            <div className="flex flex-wrap items-center gap-2">
              {confirmPower === "reboot" ? (
                <span className="inline-flex items-center gap-1.5 rounded-xl border border-coral/30 bg-panel px-2.5 py-1 text-xs">
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
                  className={`${button} min-h-8 border-coral/25 bg-panel px-3 text-xs text-coral hover:bg-coral/5`}
                  disabled={disabled || offline || !!busy}
                  onClick={() => setConfirmPower("reboot")}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  {t("重启主机")}
                </button>
              )}

              {confirmPower === "shutdown" ? (
                <span className="inline-flex items-center gap-1.5 rounded-xl border border-coral/30 bg-panel px-2.5 py-1 text-xs">
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
                  className={`${button} min-h-8 border-coral/25 bg-panel px-3 text-xs text-coral hover:bg-coral/5`}
                  disabled={disabled || offline || !!busy}
                  onClick={() => setConfirmPower("shutdown")}
                >
                  <Power size={13} aria-hidden="true" />
                  {t("关闭主机")}
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Tab 2: File Management */}
      {tab === "files" && (
        <div className={`grid gap-3 ${bodyPad}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={`${buttonQuiet} min-h-8 px-2 text-xs`}
              disabled={disabled || offline || !!busy || !parentDir}
              title={t("上级目录")}
              onClick={() => parentDir && void listDirectory(parentDir)}
            >
              <ArrowUp size={13} aria-hidden="true" />
            </button>
            <input
              className={`${input} min-h-8 min-w-0 flex-1 font-mono text-xs`}
              placeholder="C:\\"
              value={fsPath}
              disabled={disabled || offline}
              onChange={(e) => setFsPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fsPath.trim()) {
                  e.preventDefault();
                  void listDirectory(fsPath);
                }
              }}
            />
            <button
              type="button"
              className={`${button} min-h-8 px-2.5 text-xs`}
              disabled={disabled || offline || !fsPath.trim() || !!busy}
              onClick={() => void listDirectory(fsPath)}
            >
              <RefreshCw size={13} className={busy === "fs.list" ? "animate-spin" : ""} aria-hidden="true" />
              {t("打开")}
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void handleUpload(file);
              }}
            />
            <button
              type="button"
              className={`${button} min-h-8 px-2.5 text-xs`}
              disabled={disabled || offline || !!busy}
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload size={13} aria-hidden="true" />
              {t("上传")}
            </button>
          </div>

          {allowedRoots.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {allowedRoots.map((root) => (
                <button
                  key={root}
                  type="button"
                  className={`rounded-lg border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    fsPath === root
                      ? "border-mint/40 bg-mint/10 text-ink"
                      : "border-ink/10 text-ink/60 hover:bg-ink/5 hover:text-ink"
                  }`}
                  disabled={disabled || offline || !!busy}
                  onClick={() => void listDirectory(root)}
                >
                  {root}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                className={`${input} min-h-8 min-w-0 flex-1 font-mono text-xs`}
                placeholder={t("新建文件夹名称")}
                value={newDirName}
                disabled={disabled || offline}
                onChange={(e) => setNewDirName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newDirName.trim()) {
                    e.preventDefault();
                    void createDirectory();
                  }
                }}
              />
              <button
                type="button"
                className={`${buttonQuiet} min-h-8 shrink-0 px-2.5 text-xs`}
                disabled={disabled || offline || !newDirName.trim() || !!busy}
                onClick={() => void createDirectory()}
              >
                <FolderPlus size={13} aria-hidden="true" />
                {t("新建目录")}
              </button>
            </div>
            <span className="text-[11px] text-ink/45">{t("单文件上限 512 KB")}</span>
          </div>

          <div className={openFile ? "grid gap-3 xl:grid-cols-[minmax(15rem,0.85fr)_minmax(0,1.15fr)] xl:items-start" : "grid gap-2"}>
            <div className="grid gap-1.5">
              <div className="max-h-[24rem] overflow-y-auto rounded-xl border border-ink/10 bg-panel">
                {fsEntries.length > 0 ? (
                  fsEntries.map((entry) => (
                    <div
                      key={entry.path}
                      className={`flex flex-wrap items-center justify-between gap-2 border-b border-ink/[0.06] px-3 py-2 text-xs last:border-b-0 ${
                        openFile?.path === entry.path ? "bg-mint/[0.06]" : ""
                      }`}
                    >
                      {renaming?.from === entry.path ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          <input
                            className={`${input} min-h-7 min-w-0 flex-1 font-mono text-xs`}
                            value={renaming.to}
                            onChange={(e) => setRenaming({ ...renaming, to: e.target.value })}
                          />
                          <button
                            type="button"
                            className="rounded bg-ink px-2 py-1 text-[11px] text-white"
                            disabled={!!busy}
                            onClick={() => void confirmRename()}
                          >
                            {t("保存")}
                          </button>
                          <button
                            type="button"
                            className="text-[11px] text-ink/55 hover:text-ink"
                            onClick={() => setRenaming(null)}
                          >
                            {t("取消")}
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"
                            disabled={disabled || offline || !!busy}
                            onClick={() =>
                              entry.isDir ? void listDirectory(entry.path) : void openTextFile(entry.path)
                            }
                          >
                            {entry.isDir ? (
                              <Folder size={13} className="shrink-0 text-amber-600" aria-hidden="true" />
                            ) : (
                              <FileText size={13} className="shrink-0 text-ink/55" aria-hidden="true" />
                            )}
                            <span className="truncate font-mono">{entry.name}</span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1.5 text-ink/50">
                            {!entry.isDir && <span className="tabular-nums">{formatBytes(entry.size)}</span>}
                            {!entry.isDir && (
                              <button
                                type="button"
                                className="rounded p-1 hover:bg-ink/5 hover:text-ink"
                                title={t("下载")}
                                disabled={disabled || offline || !!busy}
                                onClick={() => void downloadFile(entry.path, entry.name)}
                              >
                                <Download size={12} aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-ink/5 hover:text-ink"
                              title={t("重命名")}
                              disabled={disabled || offline || !!busy}
                              onClick={() => setRenaming({ from: entry.path, to: entry.path })}
                            >
                              <Pencil size={12} aria-hidden="true" />
                            </button>
                            {confirmDeletePath === entry.path ? (
                              <span className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  className="rounded bg-coral px-1.5 py-0.5 text-[11px] text-white"
                                  disabled={!!busy}
                                  onClick={() => void deleteEntry(entry)}
                                >
                                  {t("删除")}
                                </button>
                                <button
                                  type="button"
                                  className="text-[11px] text-ink/55 hover:text-ink"
                                  onClick={() => setConfirmDeletePath(null)}
                                >
                                  {t("取消")}
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="rounded p-1 text-coral/80 hover:bg-coral/10 hover:text-coral"
                                title={t("删除")}
                                disabled={disabled || offline || !!busy}
                                onClick={() => setConfirmDeletePath(entry.path)}
                              >
                                <Trash2 size={12} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))
                ) : !fsLoaded ? (
                  <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center">
                    <p className="text-xs text-ink/55">{t("浏览、读写与上传（单文件上限 512 KB）")}</p>
                    <button
                      type="button"
                      className={`${button} min-h-8 px-3 text-xs`}
                      disabled={disabled || offline || !fsPath.trim() || !!busy}
                      onClick={() => void listDirectory(fsPath || defaultRoot)}
                    >
                      <Folder size={13} aria-hidden="true" />
                      {t("浏览目录")}
                    </button>
                  </div>
                ) : (
                  <p className="px-4 py-6 text-center text-xs text-ink/50">{t("目录为空")}</p>
                )}
              </div>
              {fsTruncated && (
                <p className="text-[11px] text-ink/50">{t("目录条目较多，仅显示前 1000 项")}</p>
              )}
            </div>

            {openFile && (
              <div className="grid gap-2 rounded-xl border border-ink/10 bg-ink/[0.02] p-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-ink/80">{openFile.path}</span>
                    {openFile.dirty && (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {t("未保存")}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={`${primary} min-h-7 px-2.5 text-xs`}
                      disabled={disabled || offline || !!busy || !openFile.dirty}
                      onClick={() => void saveOpenFile()}
                    >
                      <Save size={12} aria-hidden="true" />
                      {t("保存")}
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-ink/55 hover:text-ink"
                      aria-label={t("关闭")}
                      onClick={() => setOpenFile(null)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <textarea
                  rows={14}
                  className={`${input} w-full font-mono text-xs`}
                  value={openFile.content}
                  onChange={(e) => setOpenFile({ ...openFile, content: e.target.value, dirty: true })}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: PowerShell Terminal */}
      {tab === "terminal" && (
        <div className={`grid gap-3 ${bodyPad}`}>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input
              className={`${input} min-h-8 font-mono text-xs`}
              placeholder={t("工作目录 cwd（可选，留空自动使用允许目录）")}
              value={psCwd}
              disabled={disabled || offline}
              onChange={(e) => setPsCwd(e.target.value)}
            />
            <select
              className={`${input} min-h-8 text-xs`}
              value={psShell}
              disabled={disabled || offline}
              onChange={(e) => setPsShell(e.target.value as "powershell" | "pwsh")}
            >
              <option value="powershell">powershell.exe</option>
              <option value="pwsh">pwsh</option>
            </select>
            <select
              className={`${input} min-h-8 text-xs`}
              value={psTimeoutMs}
              disabled={disabled || offline}
              onChange={(e) => setPsTimeoutMs(Number(e.target.value))}
            >
              <option value={5000}>5s</option>
              <option value={15000}>15s</option>
              <option value={30000}>30s</option>
              <option value={60000}>60s</option>
              <option value={120000}>120s</option>
            </select>
          </div>
          <textarea
            rows={6}
            className={`${input} w-full font-mono text-xs`}
            placeholder={t("输入 PowerShell 命令或脚本（Ctrl+Enter 执行）")}
            value={psScript}
            disabled={disabled || offline}
            onChange={(e) => setPsScript(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && psScript.trim()) {
                e.preventDefault();
                void executePowerShell();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-ink/45">{t("Ctrl+Enter 执行 · 超时自动终止进程树")}</span>
            <div className="flex items-center gap-2">
              {psResult && (
                <button
                  type="button"
                  className={`${buttonQuiet} min-h-8 px-2.5 text-xs`}
                  onClick={() => setPsResult(null)}
                >
                  {t("清空输出")}
                </button>
              )}
              <button
                type="button"
                className={`${primary} min-h-8 px-3 text-xs`}
                disabled={disabled || offline || !psScript.trim() || !!busy}
                onClick={() => void executePowerShell()}
              >
                <Play size={13} aria-hidden="true" />
                {busy === "powershell" ? t("执行中…") : t("执行命令")}
              </button>
            </div>
          </div>
          {psResult && (
            <div className="grid gap-1.5 rounded-xl border border-ink/10 bg-zinc-950 p-3 font-mono text-xs text-white/90">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/60">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    psResult.exitCode === 0
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-rose-500/20 text-rose-300"
                  }`}
                >
                  {`exitCode: ${psResult.exitCode ?? "null"}`}
                </span>
                <span className="tabular-nums">{`${psResult.durationMs} ms`}</span>
                {psResult.timedOut && <span className="text-coral">{t("已超时并终止进程树")}</span>}
                {(psResult.stdoutTruncated || psResult.stderrTruncated) && (
                  <span className="text-amber-300">{t("输出已截断")}</span>
                )}
              </div>
              {psResult.stdout && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-emerald-300">
                  {psResult.stdout}
                </pre>
              )}
              {psResult.stderr && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-rose-300">
                  {psResult.stderr}
                </pre>
              )}
              {!psResult.stdout && !psResult.stderr && (
                <span className="text-white/40">{t("（无输出）")}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
