/**
 * Iframe-compatibility utilities for the workspace tab system.
 *
 * Some third-party services explicitly refuse to render inside an iframe
 * (Stripe Checkout, OAuth providers, banks, etc.) via X-Frame-Options or
 * `Content-Security-Policy: frame-ancestors`. The browser can't be forced
 * to embed them — and even if we tried via a reverse-proxy header rewrite,
 * the service's anti-fraud / ToS would reject the request anyway.
 *
 * For those, we want the workspace to:
 *   1. Detect the URL is known-blocked BEFORE attempting iframe load.
 *   2. Render a fallback panel telling the user "open externally".
 *   3. Open the URL in a new window when they click — workspace stays
 *      visible behind it, so they don't feel they "left" the workspace.
 *
 * This file is the host-pattern registry + the openManagedPopup helper.
 * It's intentionally a flat list rather than fancy CSP-probing because:
 *   - CSP / X-Frame-Options can't be probed reliably from JS (the iframe
 *     `onLoad` fires for blocked responses too, and `contentDocument` is
 *     null for any legit cross-origin frame).
 *   - A maintained list of known offenders catches 95% of real cases.
 *   - Anything not on the list still tries the iframe and the user gets
 *     a manual "Open externally" overlay button as a fallback escape.
 */

/**
 * Hosts (or host suffixes) whose pages refuse iframe embedding. Matched
 * by `endsWith` against the URL's hostname so subdomains roll up.
 *
 * Keep ordered by category so adding a new entry is obvious.
 */
const BLOCKED_HOST_SUFFIXES: ReadonlyArray<{
  suffix: string;
  /** Human-readable label for the fallback panel. */
  label: string;
  /** One-line explanation shown to the user. */
  reason: string;
}> = [
  // ── Payment processors ────────────────────────────────────────
  {
    suffix: "checkout.stripe.com",
    label: "Stripe Checkout",
    reason:
      "Stripe blocks iframe embedding for payment-card security. Use Stripe Elements inline in your app, or open Checkout in a new window.",
  },
  {
    suffix: "stripe.com",
    label: "Stripe",
    reason:
      "Stripe pages generally refuse iframe embedding. Open the URL in a new window — your workspace stays visible.",
  },
  {
    suffix: "checkout.razorpay.com",
    label: "Razorpay Checkout",
    reason: "Razorpay Checkout doesn't allow iframe embedding.",
  },
  {
    suffix: "secure.payu.in",
    label: "PayU",
    reason: "PayU's hosted checkout refuses iframe embedding.",
  },
  // ── OAuth / SSO providers ─────────────────────────────────────
  {
    suffix: "accounts.google.com",
    label: "Google Sign-In",
    reason:
      "Google's OAuth consent screen refuses iframe embedding. Use the workspace popup flow or a backend-redirect-based OAuth.",
  },
  {
    suffix: "github.com/login",
    label: "GitHub Sign-In",
    reason: "GitHub's sign-in page refuses iframe embedding.",
  },
  {
    suffix: "github.com/login/oauth",
    label: "GitHub OAuth",
    reason: "GitHub's OAuth authorization page refuses iframe embedding.",
  },
  {
    suffix: "login.microsoftonline.com",
    label: "Microsoft Sign-In",
    reason: "Microsoft's sign-in page refuses iframe embedding.",
  },
  {
    suffix: "appleid.apple.com",
    label: "Apple Sign-In",
    reason: "Apple's Sign-In page refuses iframe embedding.",
  },
  {
    suffix: "auth0.com",
    label: "Auth0",
    reason: "Auth0's universal login refuses iframe embedding by default.",
  },
  // ── Banking / data providers ──────────────────────────────────
  {
    suffix: "plaid.com",
    label: "Plaid",
    reason:
      "Plaid's hosted Link page refuses iframe embedding. Use the Plaid Link JS SDK inline instead.",
  },
  // ── Social platforms / aggressive frame-busters ──────────────
  {
    suffix: "facebook.com",
    label: "Facebook",
    reason: "Facebook actively prevents iframe embedding.",
  },
  {
    suffix: "twitter.com",
    label: "Twitter / X",
    reason: "Twitter / X prevents iframe embedding for most paths.",
  },
  {
    suffix: "x.com",
    label: "X",
    reason: "X (formerly Twitter) prevents iframe embedding for most paths.",
  },
  {
    suffix: "linkedin.com",
    label: "LinkedIn",
    reason: "LinkedIn refuses iframe embedding.",
  },
  {
    suffix: "discord.com",
    label: "Discord",
    reason: "Discord refuses iframe embedding.",
  },
  {
    suffix: "discordapp.com",
    label: "Discord",
    reason: "Discord refuses iframe embedding.",
  },
];

export interface BlockedHostInfo {
  blocked: true;
  label: string;
  reason: string;
}
export interface AllowedHostInfo {
  blocked: false;
}
export type IframeCompatInfo = BlockedHostInfo | AllowedHostInfo;

/**
 * Decide whether a URL is on the known-blocked list. Returns a tagged
 * union so the caller can pull out the label / reason without
 * re-deriving them. Returns `{ blocked: false }` for any URL we don't
 * recognise — the iframe will be tried and the user can still hit the
 * always-present "open externally" overlay button if it fails.
 */
export function checkIframeCompat(url: string): IframeCompatInfo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: false };
  }
  // Match on host + first-path-segment so we can flag `github.com/login`
  // separately from `github.com/<user>/<repo>` (the latter embeds fine).
  const hostPath = `${parsed.hostname}${parsed.pathname}`;
  for (const entry of BLOCKED_HOST_SUFFIXES) {
    if (
      parsed.hostname.endsWith(entry.suffix) ||
      hostPath.startsWith(entry.suffix)
    ) {
      return {
        blocked: true,
        label: entry.label,
        reason: entry.reason,
      };
    }
  }
  return { blocked: false };
}

/**
 * Open a URL in a workspace-managed popup window — used by the "Open
 * in workspace popup" button on the BlockedServicePanel.
 *
 * The popup is intentionally NOT noopener — we want a Window reference
 * back so future flows (OAuth, payment-complete callbacks) can listen
 * for postMessage from the child. Today nothing on this side actually
 * subscribes, but having the handle ready means the OAuth/callback
 * helper can layer on without a separate plumbing pass.
 *
 * Size is sized to feel like a real browser window — wide enough for
 * Stripe Checkout's two-column layout, tall enough for an OAuth
 * consent screen + scrollbar room.
 */
export function openManagedPopup(url: string): Window | null {
  const width = 520;
  const height = 720;
  // Centre the popup over the current window so it doesn't appear off
  // to the side / on a different monitor. window.screenX/Y are the
  // parent's screen-space top-left; outerWidth/Height are its full
  // window dimensions including chrome.
  const left = Math.max(
    0,
    Math.round((window.outerWidth - width) / 2 + window.screenX)
  );
  const top = Math.max(
    0,
    Math.round((window.outerHeight - height) / 2 + window.screenY)
  );
  const features = [
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    "resizable=yes",
    "scrollbars=yes",
    "menubar=no",
    "toolbar=no",
    "location=yes",
    "status=no",
  ].join(",");
  return window.open(url, "workspace-managed-popup", features);
}

/**
 * Open a URL in a new browser tab. Uses `noopener` so the target page
 * can't navigate or close our workspace tab. Right move for "I just
 * want to read this content elsewhere" — when we need postMessage
 * back, callers reach for openManagedPopup instead.
 */
export function openInBrowserTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
