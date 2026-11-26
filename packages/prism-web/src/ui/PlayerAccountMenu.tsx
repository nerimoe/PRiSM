import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useMatch, useNavigate } from "react-router-dom";
import type { Page } from "@prism/page-protocol";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi } from "./BillingPages";
import { AccountSheetPage, PlayerDialog } from "./PlayerAccount";

export { PlayerDialog };

export function PlayerAccountMenu() {
  const shopPage = useMatch("/t/:shopCode");
  const resourcePage = useMatch("/m/*");
  const navigate = useNavigate();
  const { user, logout, activeShop, billingActive, accountMenu, setBillingActive, setAccountMenu } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [activeTab, setActiveTab] = useState<{ id: string; title: string } | null>(null);
  const [sheetBack, setSheetBack] = useState<{ label?: string; onBack: () => void } | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setActiveTab(null);
    setSheetBack(null);
    setCheckoutPending(false);
  }, [activeShop, user]);

  useEffect(() => {
    if (!user || !activeShop || accountMenu || shopPage || resourcePage) return;
    let cancelled = false;
    api<Page>(`${shopApi(activeShop, "player/page")}?view=shop`)
      .then((page) => {
        if (cancelled) return;
        setBillingActive(activeShop, page.billingActive);
        if (page.accountMenu) setAccountMenu(activeShop, page.accountMenu);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeShop, user, accountMenu, shopPage, resourcePage, locale, setBillingActive, setAccountMenu]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) {
        menu.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  if (!user) return null;

  return (
    <>
      <details ref={menu} className="player-account-menu">
        <summary className="focus-ring">
          {billingActive && accountMenu?.billingBadge && (
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
              {accountMenu.billingBadge}
            </span>
          )}
          <span className="min-w-0 truncate">{user.displayName || user.username || user.id}</span>
          <ChevronDown size={16} className="shrink-0" />
        </summary>
        <div className="player-menu-items">
          {(accountMenu?.tabs ?? []).map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                menu.current!.open = false;
                setSheetBack(null);
                setActiveTab({ id: tab.id, title: tab.label });
              }}
            >
              {tab.label}
            </button>
          ))}
          <button
            onClick={() => {
              setLocale(locale === "zh" ? "en" : "zh");
              if (activeShop && !shopPage && !resourcePage) setAccountMenu(activeShop, null);
              menu.current!.open = false;
            }}
          >
            {t("语言")}: {locale === "zh" ? "English" : "中文"}
          </button>
          <button
            onClick={async () => {
              menu.current!.open = false;
              await logout();
            }}
          >
            {accountMenu?.logoutLabel ?? t("退出登录")}
          </button>
        </div>
      </details>
      {activeTab && activeShop && (
        <PlayerDialog
          title={activeTab.title}
          onBack={sheetBack?.onBack}
          backLabel={sheetBack?.label}
          onClose={() => {
            setActiveTab(null);
            setSheetBack(null);
          }}
          dismissDisabled={checkoutPending}
        >
          <AccountSheetPage
            key={`${activeTab.id}:${activeShop}`}
            shopCode={activeShop}
            initialView={activeTab.id}
            onTitleChange={(nextTitle) =>
              setActiveTab((prev) => (prev && nextTitle ? { ...prev, title: nextTitle } : prev))
            }
            onBackChange={setSheetBack}
            onCheckoutPending={setCheckoutPending}
            onCheckout={() => {
              const code = activeShop;
              setActiveTab(null);
              setSheetBack(null);
              setCheckoutPending(false);
              setBillingActive(code, false);
              if (!shopPage) navigate(`/t/${encodeURIComponent(code)}`);
            }}
          />
        </PlayerDialog>
      )}
    </>
  );
}
