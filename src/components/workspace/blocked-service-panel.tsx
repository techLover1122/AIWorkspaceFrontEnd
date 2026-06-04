"use client";

import {
  openInBrowserTab,
  openManagedPopup,
  type BlockedHostInfo,
} from "../../utils/iframeCompat";

/**
 * Renders inside a workspace tab when the tab's URL points at a service
 * that's known to refuse iframe embedding (Stripe Checkout, OAuth
 * providers, banks, etc.).
 *
 * Why this exists — and why a reverse proxy alone wouldn't fix it:
 *   These services check the framing context on THEIR server (X-Frame-
 *   Options / CSP `frame-ancestors`) and many also include client-side
 *   frame-buster JS. Proxying their HTML through Traefik to fake a
 *   first-party origin would either (a) trigger their fraud detection
 *   (Stripe), (b) violate their terms of service (most OAuth providers),
 *   or (c) still break because of the JS-side frame check. The honest
 *   solution is to NOT iframe these — give the user one click to open
 *   them externally instead.
 *
 * The user stays "inside the workspace" — the workspace tab itself
 * stays mounted with this panel. The external content opens in a
 * popup or new tab, and when the user is done it closes / they come
 * back to the workspace which never left.
 */
export function BlockedServicePanel({
  url,
  info,
}: {
  url: string;
  info: BlockedHostInfo;
}) {
  return (
    <div className="blocked-service-panel">
      <div className="blocked-service-icon" aria-hidden>
        <svg viewBox="0 0 48 48" fill="none">
          <circle
            cx="24"
            cy="24"
            r="20"
            stroke="currentColor"
            strokeWidth="2.4"
            opacity="0.35"
          />
          <path
            d="M16 18h12v14H16z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M28 18v-2a4 4 0 0 0-8 0v2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M14 14l20 20"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            opacity="0.7"
          />
        </svg>
      </div>
      <h2 className="blocked-service-title">
        {info.label} blocks embedded preview
      </h2>
      <p className="blocked-service-reason">{info.reason}</p>
      <div className="blocked-service-url" title={url}>
        {url}
      </div>
      <div className="blocked-service-actions">
        <button
          type="button"
          className="blocked-service-btn primary"
          onClick={() => openManagedPopup(url)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            aria-hidden
          >
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M2 6h12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Open in workspace popup
        </button>
        <button
          type="button"
          className="blocked-service-btn"
          onClick={() => openInBrowserTab(url)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            aria-hidden
          >
            <path
              d="M10 3h3v3M13 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M6.5 4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Open in browser tab
        </button>
      </div>
      <div className="blocked-service-hint">
        Your workspace stays here — the popup or tab opens alongside,
        not in place of, this view.
      </div>
    </div>
  );
}
