"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";

type AuthMode = "login" | "register";

export default function AccountPage() {
  const router = useRouter();
  const { user, pending, error, setError, login, logout, register } = useAuth();
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const normalizedUsername = username.trim();
    const normalizedDisplayName = displayName.trim();

    if (authMode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    const result =
      authMode === "register"
        ? await register({
            username: normalizedUsername,
            password,
            displayName: normalizedDisplayName || undefined,
          })
        : await login({
            username: normalizedUsername,
            password,
          });

    if (result.ok) {
      setPassword("");
      setConfirmPassword("");
      router.push("/");
    }
  }

  async function handleLogout() {
    await logout();
    setPassword("");
    setConfirmPassword("");
  }

  return (
    <main className="shell auth-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Account</p>
          <h1>账号登录</h1>
        </div>
        <div className="topbar-actions">
          <button className="compact-button" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </div>
      </section>

      <section className="auth-layout">
        <section className="panel auth-card">
          <div>
            <p className="eyebrow">{user ? "Signed In" : "Sign In"}</p>
            <h2>{user ? "当前账号" : "登录或注册"}</h2>
          </div>

          {user ? (
            <div className="account-summary">
              <div>
                <span>游戏昵称</span>
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </div>
              <div>
                <span>积分</span>
                <strong>{user.points}</strong>
                <small>初始积分 1000</small>
              </div>
              <div>
                <span>战绩</span>
                <strong>
                  {user.gamesWon}/{user.gamesPlayed}
                </strong>
                <small>胜率 {formatWinRate(user.gamesPlayed, user.gamesWon)}</small>
              </div>
              <button className="secondary" disabled={pending} onClick={handleLogout}>
                退出登录
              </button>
              <button disabled={pending} onClick={() => router.push("/profile")}>
                管理个人信息
              </button>
              <button disabled={pending} onClick={() => router.push("/")}>
                返回大厅
              </button>
            </div>
          ) : (
            <>
              <div className="auth-tabs">
                <button
                  className={authMode === "login" ? "selected" : ""}
                  type="button"
                  onClick={() => {
                    setAuthMode("login");
                    setError("");
                  }}
                >
                  登录
                </button>
                <button
                  className={authMode === "register" ? "selected" : ""}
                  type="button"
                  onClick={() => {
                    setAuthMode("register");
                    setError("");
                  }}
                >
                  注册
                </button>
              </div>

              <form className="auth-form" onSubmit={handleAuthSubmit}>
                <label className="field">
                  <span>账号</span>
                  <input
                    autoComplete="username"
                    value={username}
                    maxLength={20}
                    placeholder="letters_123"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>

                {authMode === "register" && (
                  <label className="field">
                    <span>游戏昵称（可不填）</span>
                    <input
                      autoComplete="nickname"
                      value={displayName}
                      maxLength={16}
                      placeholder="默认使用账号"
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </label>
                )}

                <label className="field">
                  <span>密码</span>
                  <input
                    autoComplete={
                      authMode === "register" ? "new-password" : "current-password"
                    }
                    type="password"
                    value={password}
                    minLength={6}
                    maxLength={72}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>

                {authMode === "register" && (
                  <label className="field">
                    <span>确认密码</span>
                    <input
                      autoComplete="new-password"
                      type="password"
                      value={confirmPassword}
                      minLength={6}
                      maxLength={72}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                    />
                  </label>
                )}

                <button disabled={pending} type="submit">
                  {authMode === "register" ? "注册并登录" : "登录"}
                </button>
              </form>

              {error && <p className="error">{error}</p>}
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function formatWinRate(gamesPlayed: number, gamesWon: number) {
  if (gamesPlayed <= 0) {
    return "0%";
  }

  return `${Math.round((gamesWon / gamesPlayed) * 100)}%`;
}
