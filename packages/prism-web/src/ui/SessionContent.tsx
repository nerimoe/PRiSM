import { useEffect, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Api, api } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { post, shopApi } from "./BillingPages";

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

export function SessionSignIn({ next }: { next: string }) {
  const { t, errorText } = useI18n();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function passkey() {
    setBusy("passkey"); setError("");
    try {
      await Api.loginWithPasskey(await startAuthentication({ optionsJSON: await Api.passkeyOptions() }));
      await refresh();
    } catch (e) { const message = passkeyErrorMessage(e); if (message) setError(errorText(message)); }
    finally { setBusy(""); }
  }
  return <div className="session-actions">
    <button className="session-action primary" disabled={!!busy} onClick={() => { setBusy("munet"); window.location.assign(`/api/v1/auth/munet?next=${encodeURIComponent(next)}`); }}>
      {busy === "munet" ? <Loader2 size={24} className="animate-spin" /> : <img src="/munet-logo.png" alt="" width={24} height={24} className="size-6 object-contain" />}
      {t(busy === "munet" ? "正在连接 MuNET…" : "使用 MuNET 登录")}
    </button>
    <button className="session-action" disabled={!!busy || !browserSupportsWebAuthn()} onClick={() => void passkey()}>
      {busy === "passkey" ? <Loader2 size={24} className="animate-spin" /> : <Fingerprint size={24} />}
      {t(busy === "passkey" ? "正在验证 Passkey…" : "使用 Passkey 登录")}
    </button>
    {!browserSupportsWebAuthn() && <p className="session-subtitle text-center">{t("当前浏览器不支持 Passkey，请使用 MuNET 登录")}</p>}
    {error && <p role="alert" className="text-coral">{error}</p>}
  </div>;
}

export function QQBinding({ code }: { code: string }) {
  const { t, errorText } = useI18n();
  const [binding, setBinding] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setBinding(null); setError("");
    api<{ code: string; expiresAt: string }>(shopApi(code, "qq-binding"), post()).then(result => {
      if (cancelled) return;
      setBinding(result);
      timer = setTimeout(() => setAttempt(value => value + 1), Math.max(1000, Date.parse(result.expiresAt) - Date.now()));
    }).catch(e => { if (!cancelled) setError(errorText(e instanceof Error ? e.message : "操作失败")); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, attempt, errorText]);
  return <div className="grid gap-6"><h2>{t("绑定 QQ")}</h2><div className="binding-code">
    <p>{t("在 QQ 群中发送")}</p>
    {binding ? <><code className="select-all">prism.bind {binding.code}</code><small>{t("有效期至")} {new Date(binding.expiresAt).toLocaleTimeString()}</small></> : error ? <><p role="alert">{error}</p><button className="session-action" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></> : <Loader2 className="animate-spin" />}
  </div></div>;
}
