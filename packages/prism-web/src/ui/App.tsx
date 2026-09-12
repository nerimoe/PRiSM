import { PlayerAccountMenu } from "./PlayerAccountMenu";
import { useI18n } from "../i18n";
import { lazy, Suspense, type ReactNode } from "react";
import {
  Link,
  Navigate,
  NavLink,
  useLocation,
  Route,
  Routes,
} from "react-router-dom";
import { Gamepad2, IdCard, Shield, Store, UserRound } from "lucide-react";
import { AuthProvider, useAuth } from "./AuthContext";
import { AuthPage } from "./AuthPage";

const MerchantBillingPage = lazy(() =>
  import("./MerchantBillingPage").then((module) => ({
    default: module.MerchantBillingPage,
  })),
);
const AdminPage = lazy(() =>
  import("./AdminPage").then((module) => ({ default: module.AdminPage })),
);
const CardsPage = lazy(() =>
  import("./CardsPage").then((module) => ({ default: module.CardsPage })),
);
const MachineLoginPage = lazy(() =>
  import("./MachineLoginPage").then((module) => ({
    default: module.MachineLoginPage,
  })),
);
const MerchantPage = lazy(() =>
  import("./MerchantPage").then((module) => ({ default: module.MerchantPage })),
);
const SettingsPage = lazy(() =>
  import("./SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const machineSession = pathname === "/m" || pathname.startsWith("/m/");
  return (
    <div className="min-h-screen bg-canvas text-ink">
      {!machineSession && (
        <header className="site-header">
          <div className="site-header-inner">
            <Link to="/" className="site-brand focus-ring">
              <span className="grid size-10 place-items-center rounded-2xl bg-mint text-white">
                <Gamepad2 size={20} />
              </span>
              PRiSM
            </Link>
            <nav className="site-navigation" aria-label={t("主导航")}>
              <NavItem
                to="/cards"
                icon={<IdCard size={16} />}
                label={t("卡片")}
              />
              {(user?.hasShops || user?.role === "admin") && (
                <NavItem
                  to="/merchant"
                  icon={<Store size={16} />}
                  label={t("店家")}
                />
              )}
              {user?.role === "admin" && (
                <NavItem
                  to="/admin"
                  icon={<Shield size={16} />}
                  label={t("管理")}
                />
              )}
              {user && (
                <NavItem
                  to="/settings"
                  icon={<UserRound size={16} />}
                  label={t("账号")}
                />
              )}
              {user ? (
                <PlayerAccountMenu />
              ) : (
                <NavLink
                  className="focus-ring rounded px-3 py-2 hover:bg-ink/5"
                  to="/login"
                >
                  {t("登录")}
                </NavLink>
              )}
            </nav>
          </div>
        </header>
      )}
      {machineSession && (
        <div className="player-account-bar">
          <PlayerAccountMenu />
        </div>
      )}
      <main className={machineSession ? "session-main" : "site-main"}>
        <Suspense
          fallback={
            <div className="rounded border border-ink/10 bg-panel p-6">
              {t("加载中...")}
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Navigate to="/cards" replace />} />
            <Route
              path="/t/:shopCode"
              element={<Navigate to="/m/expired" replace />}
            />
            <Route path="/login" element={<AuthPage />} />
            <Route
              path="/register"
              element={<Navigate to="/login" replace />}
            />
            <Route path="/cards" element={<CardsPage />} />
            <Route path="/merchant" element={<MerchantPage />} />
            <Route
              path="/merchant/:shopCode/billing/:section?"
              element={<MerchantBillingPage />}
            />
            <Route
              path="/merchant/:shopCode/:section?"
              element={<MerchantPage />}
            />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/m" element={<MachineLoginPage />} />
            <Route path="/m/expired" element={<MachineLoginPage />} />
            <Route path="/m/:ticket" element={<MachineLoginPage />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `focus-ring site-nav-item ${isActive ? "is-active" : ""}`
      }
    >
      {icon}
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}
