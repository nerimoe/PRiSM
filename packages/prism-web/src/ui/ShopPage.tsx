// Standalone shop surface at /t/:shopCode — the shop code without a machine id.
//
// This is the deep-link target for the PRiSM Link Live Activity / Dynamic Island. It works
// with no machine ticket, so it relies only on shop-scoped player endpoints (which need a
// session cookie plus a shop_player_accounts row). Admission is deliberately absent: only a
// scanned machine ticket proves the player is on site, so this page settles bills instead of
// starting sessions.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { RequireLogin } from "./RequireLogin";
import { shopApi, type ShopInfo, type Summary } from "./BillingPages";
import { AccountContent, playerSections, type Section } from "./PlayerAccount";

export default function ShopPage() {
  const { shopCode = "" } = useParams();
  return (
    <RequireLogin>
      <ShopSurface shopCode={shopCode} />
    </RequireLogin>
  );
}

function ShopSurface({ shopCode }: { shopCode: string }) {
  const { t } = useI18n();
  const { user, setActiveShop, setBillingActive } = useAuth();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [section, setSection] = useState<Section>("账单");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // A deep link carries the shop in the path, so seed the shared active shop here.
  // MachineLoginPage is otherwise the only writer.
  useEffect(() => {
    if (shopCode) setActiveShop(shopCode);
  }, [shopCode, setActiveShop]);

  const load = useCallback(async () => {
    if (!shopCode) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ShopInfo>(shopApi(shopCode));
      setInfo(result);
      const canReadPlayer =
        result.shop.billingEnabled && result.membership != null;
      const current = canReadPlayer
        ? await api<Summary>(shopApi(shopCode, "player/me"))
        : null;
      setSummary(current);
      setBillingActive(shopCode, !!current?.activeSession);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  }, [shopCode, setBillingActive, t]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  const active = summary?.activeSession ?? null;
  const canUseAccount = !!info?.shop.billingEnabled && info?.membership != null;

  if (busy && !info)
    return (
      <div className="rounded border border-ink/10 bg-panel p-6">
        <Loader2 className="mx-auto animate-spin" size={24} />
      </div>
    );
  if (!info)
    return (
      <div className="rounded border border-ink/10 bg-panel p-6">
        <p role="alert">{error || t("没有找到这个店铺")}</p>
        <button className="mt-3 underline" onClick={() => setAttempt((v) => v + 1)}>
          {t("重试")}
        </button>
      </div>
    );

  const name = info.shop.name || shopCode;
  return (
    <div className="shop-surface grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold">{name}</h1>
        {active ? (
          <p className="inline-flex items-center gap-2 text-sm text-ink/70">
            <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
            {t("正在计费 · 查看并结账")}
          </p>
        ) : (
          <p className="text-sm text-ink/60">
            {t("在这里查看账单、兑换、记录与钱包。")}
          </p>
        )}
        <p className="text-xs text-ink/50">
          {user?.displayName || user?.username || user?.id}
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}

      {!info.shop.billingEnabled && (
        <p className="rounded border border-ink/10 bg-panel p-5 text-sm text-ink/60">
          {t("本店未启用入场计费，暂无账单功能。")}
        </p>
      )}

      {info.shop.billingEnabled && info.membership == null && (
        <section className="grid gap-3 rounded border border-ink/10 bg-panel p-5">
          <h2 className="font-semibold">{t("先绑定 QQ 才能使用本店计费")}</h2>
          <p className="text-sm leading-relaxed text-ink/60">
            {t(
              "本店的玩家档案与 QQ 绑定，请在店铺机器人中完成验证后再回到这里。",
            )}
          </p>
          {info.shop.botContact && (
            <p className="text-sm">
              {t("店铺联系方式")}: <span className="font-mono">{info.shop.botContact}</span>
            </p>
          )}
        </section>
      )}

      {/* Admission belongs to a machine: only a scanned ticket proves the player is at one,
          so this page never starts a session. It points at the machine instead. */}
      {canUseAccount && !active && (
        <p className="rounded border border-ink/10 bg-panel p-5 text-sm leading-relaxed text-ink/60">
          {t("请碰一下 NFC 或扫描机台上的二维码入场")}
        </p>
      )}

      {canUseAccount && (
        <section className="grid gap-4">
          <nav className="flex flex-wrap gap-2" aria-label={t("账户")}>
            {playerSections.map((item) => (
              <button
                key={item}
                className={`focus-ring rounded-full border px-4 py-1.5 text-sm ${
                  item === section
                    ? "border-transparent bg-ink text-panel"
                    : "border-ink/15"
                }`}
                aria-current={item === section ? "page" : undefined}
                onClick={() => setSection(item)}
              >
                {t(item)}
              </button>
            ))}
          </nav>
          <div className="rounded border border-ink/10 bg-panel p-5">
            <AccountContent
              key={section + shopCode + (active ? "active" : "idle")}
              section={section}
              info={info}
            />
          </div>
        </section>
      )}
    </div>
  );
}
