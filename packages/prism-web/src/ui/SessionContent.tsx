import { useLocation, useSearchParams } from "react-router-dom";
import { billTime } from "./bill-time";
import { useEffect, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Api, api } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { post, shopApi } from "./BillingPages";
import { bindingPromptLines, defaultBindingCommand, type BindingPromptLine } from "../binding-prompt";
import type { PageBinding, PageSignInMethod } from "@prism/page-protocol";

export function ShopHero({ name, heroUrl, subtitle }: { name: string; heroUrl?: string | null; subtitle: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [heroUrl]);
  return <header className="machine-hero">
    {heroUrl && !failed && <img src={heroUrl} alt="" decoding="async" onError={() => setFailed(true)} />}
    <div className="machine-hero-info">
      {heroUrl && !failed && <img src={heroUrl} alt="" decoding="async" aria-hidden="true" />}
      <h1>{name}</h1><p>{subtitle}</p>
    </div>
  </header>;
}

export function SessionSignIn({ methods }: { methods: PageSignInMethod[] }) {
  const { t, errorText } = useI18n();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [params] = useSearchParams();
  const location = useLocation();
  const nextParams = new URLSearchParams(params);
  nextParams.delete("error"); nextParams.delete("setup");
  const next = location.pathname + (nextParams.size ? `?${nextParams}` : "") + location.hash;
  const queryError = params.get("error");
  const displayedError = error || (queryError === "MuNET 授权已取消" ? "" : queryError);
  const passkeyMethod = methods.find((method) => method.provider === "passkey");
  async function passkey() {
    setBusy("passkey"); setError("");
    try {
      await Api.loginWithPasskey(await startAuthentication({ optionsJSON: await Api.passkeyOptions() }));
      await refresh();
    } catch (e) { const message = passkeyErrorMessage(e); if (message) setError(message); }
    finally { setBusy(""); }
  }
  return <div className="session-actions">
    {methods.map((method) => {
      const styleClass = `session-action${method.style === "primary" ? " primary" : ""}`;
      if (method.provider === "munet") {
        return <button key={method.id} className={styleClass} disabled={!!busy} onClick={() => { setBusy("munet"); window.location.assign(`/api/v1/auth/munet?next=${encodeURIComponent(next)}`); }}>
          {busy === "munet" ? <Loader2 size={24} className="animate-spin" /> : <img src="/munet-logo.png" alt="" width={24} height={24} className="size-6 object-contain" />}
          {busy === "munet" ? method.busyLabel : method.label}
        </button>;
      }
      if (method.provider === "passkey") {
        return <button key={method.id} className={styleClass} disabled={!!busy || !browserSupportsWebAuthn()} onClick={() => void passkey()}>
          {busy === "passkey" ? <Loader2 size={24} className="animate-spin" /> : <Fingerprint size={24} />}
          {busy === "passkey" ? method.busyLabel : method.label}
        </button>;
      }
      return null;
    })}
    {!browserSupportsWebAuthn() && passkeyMethod?.unsupportedText && <p className="session-subtitle text-center">{passkeyMethod.unsupportedText}</p>}
    {displayedError && <p role="alert" className="text-coral">{errorText(displayedError)}</p>}
  </div>;
}

export type BindingLabels = Pick<PageBinding, "title" | "expiresLabel" | "copyLabel" | "copiedLabel" | "retryLabel">;
type CopyLabels = Pick<PageBinding, "copyLabel" | "copiedLabel">;

export function PlatformBinding({ code, labels }: { code: string; labels: BindingLabels }) {
  const { errorText } = useI18n();
  const [binding, setBinding] = useState<{ code: string; expiresAt: string; lines: BindingPromptLine[] } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setBinding(null); setError("");
    api<{ code: string; expiresAt: string; lines: BindingPromptLine[] }>(shopApi(code, "platform-binding"), post()).then(result => {
      if (cancelled) return;
      setBinding(result);
      timer = setTimeout(() => setAttempt(value => value + 1), Math.max(1000, Date.parse(result.expiresAt) - Date.now()));
    }).catch(e => { if (!cancelled) setError(errorText(e instanceof Error ? e.message : "操作失败")); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, attempt, errorText]);
  return <div className="grid gap-6"><h2 className="binding-title">{labels.title}</h2><div className="binding-code">
    {binding ? <>
      <BindingLines lines={binding.lines} labels={labels} />
      <small>{labels.expiresLabel} {billTime(binding.expiresAt).time}</small>
    </> : error ? <><p role="alert">{error}</p><button className="session-action" onClick={() => setAttempt(value => value + 1)}>{labels.retryLabel}</button></> : <Loader2 className="animate-spin" />}
  </div></div>;
}

function useCopyLabels(): CopyLabels {
  const { t } = useI18n();
  return { copyLabel: t("复制"), copiedLabel: t("已复制") };
}

/** The shop's own binding instructions as a player will see them, or the standard ones when it wrote none. */
export function BindingPrompt({ template, code }: { template?: string | null; code: string }) {
  const { t } = useI18n();
  const copy = useCopyLabels();
  const lines = bindingPromptLines(template, code) ?? [
    { text: t("向店铺 Bot 发送"), command: false },
    { text: defaultBindingCommand(code), command: true },
  ];
  return <BindingLines lines={lines} labels={copy} />;
}

function BindingLines({ lines, labels }: { lines: BindingPromptLine[]; labels: CopyLabels }) {
  return <>{lines.map((line, index) => line.command
    ? <div key={index} className="binding-command"><code className="select-all">{line.text}</code><CopyCommand value={line.text} labels={labels} /></div>
    : <p key={index}>{line.text}</p>)}</>;
}

function CopyCommand({ value, labels }: { value: string; labels: CopyLabels }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="binding-copy" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* The command stays selectable when the clipboard is denied. */ }
  }}>{copied ? labels.copiedLabel : labels.copyLabel}</button>;
}
