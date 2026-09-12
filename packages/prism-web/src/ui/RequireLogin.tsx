import { useI18n } from "../i18n";
import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { User } from "../api";
import { useAuth } from "./AuthContext";

export function RequireLogin({ children, roles }: { children: ReactNode; roles?: User["role"][] }) {
  const { t } = useI18n();
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="rounded border border-ink/10 bg-panel p-6">{t("加载中...")}</div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/cards" replace />;
  return children;
}
