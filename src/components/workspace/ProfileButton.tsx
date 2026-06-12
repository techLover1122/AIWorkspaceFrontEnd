"use client";

import { useEffect, useRef, useState } from "react";
import {
  PLATFORM_DOMAIN,
  INSTANCE_IP,
  USER_ID,
  clearAuthUrl,
  avatarUrl,
} from "../../constant/api";
import { MiniBot } from "../chat/MiniBot";

const SERVER_LABEL = PLATFORM_DOMAIN || INSTANCE_IP || "localhost";
const STORAGE_KEY = "aiide.claude-connected";

function UserIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="5.5" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1l1-1.5h3L9.5 4h3A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** The avatar face: the user's uploaded image, or the AI bot by default. */
function AvatarFace({ src }: { src: string | null }) {
  if (src) {
    return <img className="profile-avatar-img" src={src} alt="" draggable={false} />;
  }
  return <MiniBot frozen />;
}

export function ProfileButton() {
  const [open, setOpen] = useState(false);
  const [showAccountInfo, setShowAccountInfo] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [avatarVer, setAvatarVer] = useState(0);
  const [uploading, setUploading] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Probe the custom avatar; fall back to the bot when there's none.
  useEffect(() => {
    let cancelled = false;
    const src = `${avatarUrl()}?v=${avatarVer}`;
    const img = new Image();
    img.onload = () => { if (!cancelled) setAvatarSrc(src); };
    img.onerror = () => { if (!cancelled) setAvatarSrc(null); };
    img.src = src;
    return () => { cancelled = true; };
  }, [avatarVer]);

  // Position the dropdown (fixed) below the button.
  function openDropdown() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownStyle({ top: rect.bottom + 4, left: rect.left });
    }
    setShowAccountInfo(false);
    setOpen((s) => !s);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current?.contains(target) ||
        btnRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleLogout() {
    setOpen(false);
    try {
      await fetch(clearAuthUrl(), { method: "POST" });
    } catch {
      /* ignore network errors — still clear local state */
    }
    window.localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }

  function handleAccount() {
    setShowAccountInfo((s) => !s);
  }

  function pickFile() {
    fileRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    setUploading(true);
    try {
      const r = await fetch(avatarUrl(), { method: "POST", body: fd });
      if (r.ok) setAvatarVer((v) => v + 1);
    } catch {
      /* ignore — keep current avatar */
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setUploading(true);
    try {
      await fetch(avatarUrl(), { method: "DELETE" });
      setAvatarVer((v) => v + 1);
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`profile-avatar-btn${open ? " open" : ""}${avatarSrc ? " has-img" : " is-bot"}`}
        onClick={openDropdown}
        title="Account & profile"
        aria-label="User account"
        aria-expanded={open}
      >
        <AvatarFace src={avatarSrc} />
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="profile-dropdown"
          style={dropdownStyle}
        >
          {/* ── User info header ── */}
          <div className="profile-dropdown-header">
            <div className="profile-dropdown-avatar-wrap">
              <div className={`profile-dropdown-avatar${avatarSrc ? " has-img" : " is-bot"}`}>
                <AvatarFace src={avatarSrc} />
              </div>
              <button
                type="button"
                className="profile-avatar-camera"
                onClick={pickFile}
                disabled={uploading}
                title={avatarSrc ? "Change photo" : "Upload photo"}
                aria-label={avatarSrc ? "Change photo" : "Upload photo"}
              >
                <CameraIcon />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={onFileChange}
              />
            </div>
            <div className="profile-dropdown-meta">
              <span className="profile-dropdown-id" title={USER_ID || undefined}>
                {USER_ID ? `${USER_ID.slice(0, 14)}…` : "—"}
              </span>
              <span className="profile-dropdown-server">{SERVER_LABEL}</span>
            </div>
          </div>

          <div className="profile-dropdown-divider" />

          {/* ── Account ── */}
          <button
            type="button"
            className={`profile-dropdown-item${showAccountInfo ? " active" : ""}`}
            onClick={handleAccount}
          >
            <UserIcon />
            Account
          </button>

          {showAccountInfo && (
            <div className="profile-account-panel">
              <div className="profile-account-row">
                <span>User</span>
                <span className="profile-account-val" title={USER_ID || undefined}>
                  {USER_ID || "—"}
                </span>
              </div>
              <div className="profile-account-row">
                <span>Server</span>
                <span className="profile-account-val">{SERVER_LABEL}</span>
              </div>
              {avatarSrc && (
                <div className="profile-avatar-actions">
                  <button
                    type="button"
                    className="profile-avatar-action danger"
                    onClick={removeAvatar}
                    disabled={uploading}
                  >
                    {uploading ? "Working…" : "Remove photo"}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="profile-dropdown-divider" />

          {/* ── Logout ── */}
          <button
            type="button"
            className="profile-dropdown-item logout"
            onClick={handleLogout}
          >
            <LogoutIcon />
            Logout
          </button>
        </div>
      )}
    </>
  );
}
