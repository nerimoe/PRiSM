import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { AccountSheetPage, PlayerDialog } from "./PlayerAccount";

export { PlayerDialog };

/** Shop-scoped menu items only belong on active shop player pages (`/t/:shopCode`, `/m`, `/m/:ticket`). */
export function isShopAccountMenuPath(pathname: string): boolean {
  if (pathname === "/m" || pathname === "/m/") return true;
  if (pathname.startsWith("/m/")) return pathname !== "/m/expired" && pathname !== "/m/expired/";
  return /^\/t\/[^/]+\/?$/.test(pathname);
}

export function PlayerAccountMenu() {
  const { pathname } = useLocation();
  const shopPage = useMatch("/t/:shopCode");
  const navigate = useNavigate();
  const { user, logout, activeShop, billingActive, accountMenu, setBillingActive } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [activeTab, setActiveTab] = useState<{ id: string; title: string } | null>(null);
  const [sheetBack, setSheetBack] = useState<{ label?: string; onBack: () => void } | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const showShopMenu = isShopAccountMenuPath(pathname) && Boolean(activeShop);

  useEffect(() => {
    setActiveTab(null);
    setSheetBack(null);
    setCheckoutPending(false);
  }, [showShopMenu, activeShop, user]);

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

  const shopTabs = (showShopMenu ? (accountMenu?.tabs ?? []) : []).filter(
    (tab) => !shopPage || tab.id !== "bill",
  );

  return (
    <>
      <details ref={menu} className="player-account-menu">
        <summary className="focus-ring">
          {showShopMenu && billingActive && accountMenu?.billingBadge && (
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
              {accountMenu.billingBadge}
            </span>
          )}
          <span className="min-w-0 truncate">{user.displayName || user.username || user.id}</span>
          <ChevronDown size={16} className="shrink-0" />
        </summary>
        <div className="player-menu-items">
          {shopTabs.map((tab) => (
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
            {(showShopMenu ? accountMenu?.logoutLabel : undefined) ?? t("退出登录")}
          </button>
        </div>
      </details>
      {showShopMenu && activeTab && activeShop && (
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
            onRefreshHost={() => {
              setActiveTab(null);
              setSheetBack(null);
              setCheckoutPending(false);
              window.dispatchEvent(new CustomEvent("prism:shop-refresh"));
            }}
            onCheckoutPending={setCheckoutPending}
            onCheckout={() => {
              const code = activeShop;
              setActiveTab(null);
              setSheetBack(null);
              setCheckoutPending(false);
              setBillingActive(code, false);
              if (!shopPage) navigate(`/t/${encodeURIComponent(code)}`);
              else window.dispatchEvent(new CustomEvent("prism:shop-refresh"));
            }}
          />
        </PlayerDialog>
      )}
    </>
  );
}
