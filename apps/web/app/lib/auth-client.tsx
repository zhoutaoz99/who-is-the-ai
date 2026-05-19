"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  points: number;
  gamesPlayed: number;
  gamesWon: number;
  createdAt: string;
};

type AuthPayload = {
  username: string;
  password: string;
  displayName?: string;
};

type AuthResult = {
  ok: boolean;
  error?: string;
  token?: string;
  user?: AuthUser;
};

type ProfilePayload = {
  displayName?: string;
};

type AuthClientContextValue = {
  user: AuthUser | null;
  token: string;
  pending: boolean;
  error: string;
  setError: (value: string) => void;
  register: (payload: AuthPayload) => Promise<AuthResult>;
  login: (payload: AuthPayload) => Promise<AuthResult>;
  updateProfile: (payload: ProfilePayload) => Promise<AuthResult>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<AuthResult>;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const AUTH_TOKEN_KEY = "ai-werewolf-auth-token";

const AuthClientContext = createContext<AuthClientContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const applySession = useCallback((nextToken: string, nextUser: AuthUser) => {
    setToken(nextToken);
    setUser(nextUser);
    window.localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setToken("");
    setUser(null);
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }, []);

  const requestAuth = useCallback(
    async (endpoint: "register" | "login", payload: AuthPayload) => {
      setError("");
      setPending(true);

      try {
        const response = await fetch(`${API_URL}/auth/${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const result = (await response.json()) as AuthResult;

        if (!result.ok || !result.token || !result.user) {
          const failedResult = {
            ok: false,
            error: result.error ?? "账号请求失败",
          };
          setError(failedResult.error);
          return failedResult;
        }

        applySession(result.token, result.user);
        return result;
      } catch {
        const failedResult = {
          ok: false,
          error: "无法连接账号服务",
        };
        setError(failedResult.error);
        return failedResult;
      } finally {
        setPending(false);
      }
    },
    [applySession],
  );

  const refreshMe = useCallback(async () => {
    const storedToken = window.localStorage.getItem(AUTH_TOKEN_KEY) ?? "";
    if (!storedToken) {
      return {
        ok: false,
        error: "未登录",
      };
    }

    setPending(true);
    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${storedToken}`,
        },
      });
      const result = (await response.json()) as AuthResult;

      if (!result.ok || !result.user) {
        clearSession();
        return {
          ok: false,
          error: result.error ?? "登录状态已过期",
        };
      }

      setToken(storedToken);
      setUser(result.user);
      return {
        ok: true,
        user: result.user,
      };
    } catch {
      clearSession();
      return {
        ok: false,
        error: "无法连接账号服务",
      };
    } finally {
      setPending(false);
    }
  }, [clearSession]);

  const logout = useCallback(async () => {
    const currentToken = token || window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
    clearSession();
    setError("");

    if (!currentToken) {
      return;
    }

    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
      });
    } catch {
      // Local logout is still complete even if the server request fails.
    }
  }, [clearSession, token]);

  const updateProfile = useCallback(
    async (payload: ProfilePayload) => {
      const currentToken = token || window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
      if (!currentToken) {
        const failedResult = {
          ok: false,
          error: "请先登录账号",
        };
        setError(failedResult.error);
        return failedResult;
      }

      setError("");
      setPending(true);
      try {
        const response = await fetch(`${API_URL}/auth/profile`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${currentToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const result = (await response.json()) as AuthResult;

        if (!result.ok || !result.user) {
          const failedResult = {
            ok: false,
            error: result.error ?? "个人信息更新失败",
          };
          setError(failedResult.error);
          return failedResult;
        }

        setUser(result.user);
        return result;
      } catch {
        const failedResult = {
          ok: false,
          error: "无法连接账号服务",
        };
        setError(failedResult.error);
        return failedResult;
      } finally {
        setPending(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const value = useMemo<AuthClientContextValue>(
    () => ({
      user,
      token,
      pending,
      error,
      setError,
      register: (payload) => requestAuth("register", payload),
      login: (payload) => requestAuth("login", payload),
      updateProfile,
      logout,
      refreshMe,
    }),
    [error, logout, pending, refreshMe, requestAuth, token, updateProfile, user],
  );

  return (
    <AuthClientContext.Provider value={value}>
      {children}
    </AuthClientContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthClientContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}
