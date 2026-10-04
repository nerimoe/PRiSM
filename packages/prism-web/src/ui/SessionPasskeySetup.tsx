import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Fingerprint, Loader2 } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { Api } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useI18n } from "../i18n";

/** An optional step on the current venue page; never opens account settings. */
export function SessionPasskeySetup({ children }: { children: ReactNode }) {
  const { t, errorText } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get("setup") === "passkey";
  const [checking, setChecking] = useState(requested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();
  const finish = useCallback(() => {
    const next = new URLSearchParams(location.search);
    next.delete("setup");
    navigate({ pathname: location.pathname, search: next.size ? `?${next}` : "", hash: location.hash }, { replace: true });
  }, [navigate, location.pathname, location.search, location.hash]);
  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    setChecking(true);
    Api.account().then(account => {
      if (cancelled) return;
      if (account.passkeys.length) {
        finish();
      }
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "无法加载账号设置"); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [requested, finish]);
  async function addPasskey() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const credential = await startRegistration({ optionsJSON: await Api.passkeyRegistrationOptions() });
      await Api.registerPasskey(credential);
      finish();
    } catch (e) { setError(passkeyErrorMessage(e)); }
    finally { setBusy(false); }
  }
  if (!requested) return children;
  return <div className="session-task grid gap-6">
    <h2>{t("建议添加 Passkey")}</h2>
    <p className="session-subtitle">{t("下次可用指纹或面容快速登录。此步骤可跳过，不影响继续游玩。")}</p>
    {error && <p role="alert" className="session-error">{errorText(error)}</p>}
    {!supported && <p className="session-subtitle">{t("当前设备不支持 Passkey。")}</p>}
    <div className="session-actions !mt-0">
      {supported && <button className="session-action primary" disabled={checking || busy} onClick={() => void addPasskey()}>
        {checking || busy ? <Loader2 size={24} className="animate-spin" /> : <Fingerprint size={24} />}
        {t(busy ? "正在添加 Passkey…" : "添加 Passkey")}
      </button>}
      <button className="session-action" disabled={busy} onClick={finish}>{t("跳过，继续游玩")}</button>
    </div>
  </div>;
}
