import { useI18n } from "../i18n";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Fingerprint, Loader2 } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Api } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useAuth } from "./AuthContext";

export function AuthPage() {
  const { t, errorText } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [munetBusy, setMunetBusy] = useState(false);
  const queryError = new URLSearchParams(location.search).get("error");
  const error = passkeyError || (queryError === "MuNET 授权已取消" ? null : queryError);
  const redirectTo = new URLSearchParams(location.search).get("next") || "/cards";

  const loginWithPasskey = async () => {
    setBusy(true);
    setPasskeyError(null);
    try {
      const response = await startAuthentication({ optionsJSON: await Api.passkeyOptions() });
      await Api.loginWithPasskey(response);
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setPasskeyError(passkeyErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto max-w-[480px] py-10 sm:py-20">
      <div className="session-task !mt-0">
        <h1>{t("登录 PRiSM")}</h1>
        <p className="session-subtitle">{t("连接账号，随时管理你的卡片")}</p>
        {error && <p role="alert" className="session-error">{errorText(error)}</p>}
      </div>
      <div className="session-actions">
        <button className="session-action primary" disabled={busy || munetBusy} onClick={() => {
          setMunetBusy(true);
          window.location.assign(`/api/v1/auth/munet?next=${encodeURIComponent(redirectTo)}`);
        }}>
          {munetBusy ? <Loader2 size={24} className="shrink-0 animate-spin" aria-hidden="true" /> : <img src="/munet-logo.png" alt="" width={24} height={24} className="size-6 shrink-0 object-contain" />}
          {munetBusy ? t("正在连接 MuNET…") : t("使用 MuNET 登录")}
        </button>
        <button className="session-action" disabled={busy || munetBusy || !browserSupportsWebAuthn()} onClick={() => void loginWithPasskey()}>
          {busy ? <Loader2 size={24} className="shrink-0 animate-spin" aria-hidden="true" /> : <Fingerprint size={24} className="shrink-0" aria-hidden="true" />}
          {busy ? t("正在验证 Passkey…") : t("使用 Passkey 登录")}
        </button>
      </div>
    </section>
  );
}
