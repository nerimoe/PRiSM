import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Api, type User } from "../api";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  activeShop: string;
  setActiveShop: (code: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeShop, updateShop] = useState(
    () => sessionStorage.getItem("prism.active-shop") ?? "",
  );
  const setActiveShop = (code: string) => {
    sessionStorage.setItem("prism.active-shop", code);
    updateShop(code);
  };
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
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
      activeShop,
      setActiveShop,
      refresh,
      logout: async () => {
        await Api.logout();
        setUser(null);
        setActiveShop("");
      },
    }),
    [user, loading, activeShop],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
