import { DeviceControls } from "./DeviceControls";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Fingerprint, Loader2 } from "lucide-react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from "@simplewebauthn/browser";
import { Api, ApiError, type Card, type PublicMachine } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useAuth } from "./AuthContext";

export function MachineLoginPage() {
  const { ticket: paramTicket = "", publicId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const ticket = searchParams.get("ticket") || paramTicket || publicId;
  const queryError = searchParams.get("error");
  const expired =
    window.location.pathname === "/m/expired" ||
    searchParams.get("expired") === "1";
  return expired || !ticket ? (
    <MachineExpiredPage />
  ) : (
    <MachineSessionLoader
      key={ticket}
      ticket={ticket}
      queryError={queryError}
    />
  );
}

function MachineSessionLoader({
  ticket,
  queryError,
}: {
  ticket: string;
  queryError: string | null;
}) {
  const { loading, setActiveShop } = useAuth();
  const [page, setPage] = useState<
    | { kind: "loading" }
    | { kind: "failed"; message: string }
    | { kind: "session"; machine: PublicMachine }
  >({ kind: "loading" });
  const [machineAttempt, setMachineAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPage({ kind: "loading" });
    Api.publicMachine(ticket)
      .then((result) => {
        if (!cancelled) {
          setActiveShop(result.machine.shop.publicId ?? "");
          setPage({ kind: "session", machine: result.machine });
        }
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.sessionExpired) {
          window.location.replace("/m/expired");
          return;
        }
        setPage({
          kind: "failed",
          message:
            caught instanceof TypeError
              ? "网络连接失败，请检查网络后重试"
              : "这台机台暂时不可用，请稍后重试",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ticket, machineAttempt]);

  switch (page.kind) {
    case "loading":
      return <MachineLoadingPage />;
    case "failed":
      return (
        <MachineFailurePage
          message={page.message}
          onRetry={() => {
            setPage({ kind: "loading" });
            setMachineAttempt((value) => value + 1);
          }}
        />
      );
    case "session":
      return loading ? (
        <MachineLoadingPage />
      ) : (
        <MachineSessionPage
          machine={page.machine}
          ticket={ticket}
          queryError={queryError}
        />
      );
  }
}

function MachineSessionPage({
  machine,
  ticket,
  queryError,
}: {
  machine: PublicMachine;
  ticket: string;
  queryError: string | null;
}) {
  const { t, errorText } = useI18n();
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "locating" | "sending">("idle");
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [heroFailed, setHeroFailed] = useState(false);
  const [munetBusy, setMunetBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const shownQueryError = useRef<string | null>(null);

  useEffect(() => {
    if (
      !queryError ||
      queryError === "MuNET 授权已取消" ||
      shownQueryError.current === queryError
    )
      return;
    shownQueryError.current = queryError;
    window.alert(errorText(queryError));
  }, [queryError, errorText]);

  useEffect(() => {
    let cancelled = false;
    setCardsError(null);
    if (!user) {
      setCards([]);
      setCardsLoading(false);
      return;
    }
    setCardsLoading(true);
    Api.cards()
      .then((result) => {
        if (cancelled) return;
        const activeCards = result.cards.filter((card) => !card.disabledAt);
        setCards(activeCards);
      })
      .catch(() => {
        if (!cancelled) setCardsError("请检查网络后重试");
      })
      .finally(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, user, reload]);

  const loginWithPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const response = await startAuthentication({
        optionsJSON: await Api.passkeyOptions(),
      });
      await Api.loginWithPasskey(response);
      await refresh();
    } catch (caught) {
      const message = passkeyErrorMessage(caught);
      if (message) window.alert(errorText(message));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const loginWithCard = async (cardId: string) => {
    if (status !== "idle") return;
    setActiveCardId(cardId);
    setStatus("locating");
    try {
      const position =
        (machine.shop.locationEnabled ?? machine.shop.machineGeo) === false ? null : await getPosition();
      setStatus("sending");
      await Api.loginMachine({
        cardId,
        lat: position?.coords.latitude,
        lng: position?.coords.longitude,
        accuracy: position?.coords.accuracy,
        ticket,
      });
      window.setTimeout(() => navigate("/m/expired", { replace: true }), 3000);
    } catch (caught) {
      if (
        caught instanceof TypeError ||
        (caught instanceof ApiError &&
          ([
            "DEVICE_RESULT_UNKNOWN",
            "DEVICE_UNAVAILABLE",
            "OPERATION_PENDING",
          ].includes(caught.code ?? "") ||
            caught.sessionExpired))
      ) {
        navigate("/m/expired", { replace: true });
        return;
      }
      if (
        caught instanceof ApiError &&
        ["QQ_BINDING_REQUIRED", "CHECKIN_REQUIRED"].includes(caught.code ?? "")
      ) {
        setStatus("idle");
        setReload((value) => value + 1);
        return;
      }
      setStatus("idle");
      setActiveCardId(null);
      const message = friendlyLoginError(caught);
      window.alert(errorText(message));
    }
  };

  const munetNext = ticket ? `/m?ticket=${encodeURIComponent(ticket)}` : "/m";
  const busy = status !== "idle";
  return (
    <section className="machine-session">
      <header className="machine-hero">
        {machine.shop.heroUrl && !heroFailed && (
          <img
            src={machine.shop.heroUrl}
            alt=""
            decoding="async"
            onError={() => setHeroFailed(true)}
          />
        )}
        <div className="machine-hero-info">
          {machine.shop.heroUrl && !heroFailed && (
            <img
              src={machine.shop.heroUrl}
              alt=""
              decoding="async"
              aria-hidden="true"
            />
          )}
          <h1>{machine.shop.name}</h1>
          <p>{machine.name}</p>
        </div>
      </header>

      {!Object.values(machine.capabilities).some(Boolean) ? null : !user ? (
        <div className="session-actions">
          <button
            className="session-action primary"
            disabled={passkeyBusy || munetBusy}
            onClick={() => {
              setMunetBusy(true);
              window.location.assign(
                `/api/v1/auth/munet?next=${encodeURIComponent(munetNext)}`,
              );
            }}
          >
            {munetBusy ? (
              <Loader2
                size={24}
                className="shrink-0 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <img
                src="/munet-logo.png"
                alt=""
                width={24}
                height={24}
                className="size-6 shrink-0 object-contain"
              />
            )}
            {munetBusy ? t("正在连接 MuNET…") : t("使用 MuNET 登录")}
          </button>
          <button
            className="session-action"
            disabled={passkeyBusy || munetBusy || !browserSupportsWebAuthn()}
            onClick={() => void loginWithPasskey()}
          >
            {passkeyBusy ? (
              <Loader2
                size={24}
                className="shrink-0 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Fingerprint size={24} className="shrink-0" aria-hidden="true" />
            )}
            {passkeyBusy ? t("正在验证 Passkey…") : t("使用 Passkey 登录")}
          </button>
          {!browserSupportsWebAuthn() && (
            <p className="session-subtitle text-center">
              {t("当前浏览器不支持 Passkey，请使用 MuNET 登录")}
            </p>
          )}
        </div>
      ) : (
        <DeviceControls
          key={reload}
          machine={machine}
          ticket={ticket}
          cardBusy={busy}
        >
          {cardsLoading ? (
            <div
              className="flex justify-center"
              role="status"
              aria-label={t("正在加载卡片")}
            >
              <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            </div>
          ) : cardsError ? (
            <div className="text-center" role="status">
              <h2 className="text-xl font-semibold">{t("无法加载卡片")}</h2>
              <p className="session-subtitle">{errorText(cardsError)}</p>
              <button
                className="session-action mt-6 w-full"
                onClick={() => setReload((value) => value + 1)}
              >
                {t("重新加载卡片")}
              </button>
            </div>
          ) : cards.length ? (
            <div className="credential-list">
              {cards.map((card) => {
                const active = activeCardId === card.id;
                const detail =
                  active && status === "locating"
                    ? t("确认位置…")
                    : active && status === "sending"
                      ? t("正在登录…")
                      : t("尾号 {digits}", {
                          digits: card.accessCode.slice(-4),
                        });
                return (
                  <button
                    key={card.id}
                    className="credential-row"
                    disabled={busy}
                    data-active={active}
                    onClick={() => void loginWithCard(card.id)}
                  >
                    <span className="min-w-0">
                      <span className="credential-name">{card.label}</span>
                      <span
                        className="credential-detail"
                        aria-live={active ? "polite" : "off"}
                      >
                        {detail}
                      </span>
                    </span>
                    {active && busy ? (
                      <Loader2 size={20} className="animate-spin text-mint" />
                    ) : (
                      <ChevronRight size={20} className="text-ink/30" />
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-center">
              <p className="session-subtitle">
                {t("还没有可用卡片，请先在 PRiSM 添加卡片")}
              </p>
              <a
                className="session-action mt-4 w-full"
                href="/cards"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("添加卡片")}
              </a>
              <button
                className="session-action mt-6 w-full"
                onClick={() => setReload((value) => value + 1)}
              >
                {t("重新加载卡片")}
              </button>
            </div>
          )}
        </DeviceControls>
      )}
    </section>
  );
}

function MachineLoadingPage() {
  const { t } = useI18n();
  return (
    <section
      className="machine-session session-status"
      aria-busy="true"
      role="status"
      aria-label={t("正在加载")}
    >
      <Loader2 size={28} className="animate-spin" aria-hidden="true" />
    </section>
  );
}

function MachineFailurePage({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t, errorText } = useI18n();
  return (
    <section className="machine-session session-status">
      <h1>{t("无法进入机台会话")}</h1>
      <p>{errorText(message)}</p>
      <button className="session-action" onClick={onRetry}>
        {t("重试")}
      </button>
    </section>
  );
}

function MachineExpiredPage() {
  const { t } = useI18n();
  return (
    <section className="machine-session session-status">
      <h1>{t("本次会话已失效")}</h1>
      <p>{t("请重新碰一下 NFC 或重新扫描二维码。")}</p>
    </section>
  );
}

function friendlyLoginError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg === "geo_denied") return "需要定位权限才能确认你在店内";
    if (msg === "geo_unsupported" || msg === "geo_failed")
      return "定位获取失败";
    if (
      msg.includes("店内") ||
      msg.includes("距离") ||
      msg.includes("到店") ||
      msg.includes("位置确认失败")
    ) {
      return "请到店再进行登录";
    }
    if (msg.includes("会话已失效") || msg.includes("缺少会话凭证")) {
      return "本次会话已失效";
    }
    if (msg.includes("频繁")) {
      return "操作过于频繁，请稍后重试";
    }
    if (
      msg.includes("无法完成此操作") ||
      msg.includes("当前无法进行此操作") ||
      msg.includes("受限")
    ) {
      return "当前无法进行此操作";
    }
    if (msg.includes("卡片")) {
      return "卡片不可用或已失效";
    }
    if (
      msg.includes("机台") ||
      msg.includes("通信") ||
      msg.includes("响应") ||
      msg.includes("502")
    ) {
      return "这台机台暂时不可用，请稍后重试";
    }
  }
  return "登录失败，请稍后重试";
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geo_unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error("geo_denied"));
        } else {
          reject(new Error("geo_failed"));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 15_000,
      },
    );
  });
}
