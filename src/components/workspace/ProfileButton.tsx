"use client";

import { useEffect, useRef, useState } from "react";
import {
  PLATFORM_DOMAIN,
  INSTANCE_IP,
  USER_ID,
  clearAuthUrl,
} from "../../constant/api";

const SERVER_LABEL = PLATFORM_DOMAIN || INSTANCE_IP || "localhost";
const AVATAR_LETTER = USER_ID ? USER_ID[0].toUpperCase() : "U";
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

export function ProfileButton() {
  const [open, setOpen] = useState(false);
  const [showAccountInfo, setShowAccountInfo] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`profile-avatar-btn${open ? " open" : ""}`}
        onClick={openDropdown}
        title="Account & profile"
        aria-label="User account"
        aria-expanded={open}
      >
        {AVATAR_LETTER}
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="profile-dropdown"
          style={dropdownStyle}
        >
          {/* ── User info header ── */}
          <div className="profile-dropdown-header">
            <div className="profile-dropdown-avatar">{AVATAR_LETTER}</div>
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
