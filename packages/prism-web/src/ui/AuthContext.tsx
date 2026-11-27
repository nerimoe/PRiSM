import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PageAccountMenu } from "@prism/page-protocol";
import { Api, invalidatePlayerReads, type User } from "../api";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  billingActive: boolean;
  setBillingActive: (code: string, active: boolean) => void;
  accountMenu: PageAccountMenu | null;
  setAccountMenu: (code: string, menu: PageAccountMenu | null) => void;
  activeShop: string;
  setActiveShop: (code: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeShop, updateShop] = useState("");
  const [visit, setVisit] = useState({ shop: "", user: "", active: false });
  const setBillingActive = useCallback((code: string, active: boolean) => {
    setVisit({ shop: code, user: user?.id ?? "", active });
  }, [user?.id]);
  const [menuState, setMenuState] = useState<{ shop: string; user: string; menu: PageAccountMenu | null }>({
    shop: "",
    user: "",
    menu: null,
  });
  const setAccountMenu = useCallback((code: string, menu: PageAccountMenu | null) => {
    setMenuState({ shop: code, user: user?.id ?? "", menu });
  }, [user?.id]);
  const setActiveShop = useCallback((code: string) => {
    updateShop(code);
    if (!code) {
      setVisit({ shop: "", user: "", active: false });
      setMenuState({ shop: "", user: "", menu: null });
    }
  }, []);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    invalidatePlayerReads();
    const result = await Api.me();
    sessionStorage.setItem("prism.user", result.user?.id ?? "");
    setUser(result.user);
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      billingActive: Boolean(activeShop) && visit.active && visit.shop === activeShop && visit.user === user?.id,
      setBillingActive,
      accountMenu: activeShop && menuState.shop === activeShop && menuState.user === (user?.id ?? "") ? menuState.menu : null,
      setAccountMenu,
      activeShop,
      setActiveShop,
      refresh,
      logout: async () => {
        await Api.logout();
        setUser(null);
        setActiveShop("");
      },
    }),
    [user, loading, activeShop, visit, setBillingActive, menuState, setAccountMenu, setActiveShop],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
