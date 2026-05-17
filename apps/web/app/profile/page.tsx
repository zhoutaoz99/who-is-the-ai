"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";

function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function stringToHue(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

function Avatar({ name, size = 64 }: { name: string; size?: number }) {
  const hue = stringToHue(name || "?");
  const bg = `hsl(${hue} 60% 45%)`;
  return (
    <div
      className="profile-avatar"
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: size * 0.4,
      }}
    >
      {getInitials(name || "?")}
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { user, pending, error, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
  }, [user?.displayName]);

  async function handleUpdateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccessMessage("");

    const result = await updateProfile({
      displayName: displayName.trim() || undefined,
    });

    if (result.ok && result.user) {
      setDisplayName(result.user.displayName);
      setSuccessMessage("昵称已更新");
      setTimeout(() => setSuccessMessage(""), 3000);
    }
  }

  return (
    <main className="shell profile-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Profile</p>
          <h1>个人信息</h1>
        </div>
        <div className="topbar-actions">
          <button className="compact-button" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </div>
      </section>

      {!user ? (
        <section className="profile-layout">
          <div className="panel profile-card profile-card--center">
            <div className="profile-empty">
              <div className="profile-avatar profile-avatar--muted">?</div>
              <div>
                <h2>需要登录</h2>
                <p className="muted-text">登录后可以查看积分和修改游戏昵称。</p>
              </div>
              <button onClick={() => router.push("/account")}>登录 / 注册</button>
            </div>
          </div>
        </section>
      ) : (
        <section className="profile-layout">
          {/* 左侧：账号资料 */}
          <div className="panel profile-card">
            {/* 头部：头像 + 昵称 */}
            <div className="profile-header">
              <Avatar name={user.displayName || user.username} size={72} />
              <div className="profile-header-info">
                <strong>{user.displayName || user.username}</strong>
                <span>@{user.username}</span>
              </div>
            </div>

            {/* 积分 */}
            <div className="profile-highlight-stat">
              <span>积分</span>
              <strong>{user.points}</strong>
            </div>

            {/* 详细信息 */}
            <div className="profile-info-list">
              <div className="profile-info-row">
                <span>账号</span>
                <strong>@{user.username}</strong>
              </div>
              <div className="profile-info-row">
                <span>注册时间</span>
                <strong>{formatDateTime(user.createdAt)}</strong>
              </div>
              <div className="profile-info-row">
                <span>游戏昵称</span>
                <strong>{user.displayName || "未设置"}</strong>
              </div>
            </div>
          </div>

          {/* 右侧：修改昵称 */}
          <div className="panel profile-card">
            <div>
              <p className="eyebrow">Edit</p>
              <h2>修改昵称</h2>
              <p className="muted-text" style={{ marginTop: 6 }}>
                设置一个个性化的游戏昵称，让其他玩家更容易认出你。
              </p>
            </div>

            <form className="profile-form" onSubmit={handleUpdateProfile}>
              <label className="field">
                <span>游戏昵称</span>
                <div className="profile-input-wrap">
                  <input
                    autoComplete="nickname"
                    value={displayName}
                    maxLength={16}
                    placeholder="留空则使用账号名"
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                  <small className="profile-char-count">
                    {displayName.length}/16
                  </small>
                </div>
              </label>
              <button disabled={pending} type="submit">
                {pending ? "保存中…" : "保存昵称"}
              </button>
            </form>

            {successMessage && (
              <p className="success profile-toast">{successMessage}</p>
            )}
            {error && <p className="error profile-toast">{error}</p>}
          </div>
        </section>
      )}
    </main>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
