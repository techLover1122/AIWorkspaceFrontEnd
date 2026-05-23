import {
  INSTANCE_IP,
  PLATFORM_DOMAIN,
  USER_ID,
  registerServiceUrl,
} from "../constant/api";

/**
 * Translate a URL into something the user's browser can reliably hit:
 * the corresponding public-domain URL, with the underlying service
 * registered on the proxy router if needed.
 *
 * Three input forms get special treatment, each one resulting in a POST
 * to the backend's /api/services endpoint so Traefik routes are live:
 *
 *   1. Local-port URL — `http://localhost:5173`, `http://127.0.0.1:5173`,
 *      `http://<INSTANCE_IP>:5173`. We extract the port, register it,
 *      and rewrite the URL to the returned public host.
 *
 *   2. Auto-named platform URL — `http://port-5173-<USER_ID>.<DOMAIN>`.
 *      The subdomain encodes the port, so we can re-register
 *      defensively (idempotent) without needing more info.
 *
 *   3. Custom-named platform URL — `http://myapp-<USER_ID>.<DOMAIN>`.
 *      We don't know the port from the URL, so we just trust the URL
 *      and don't register. The AI is expected to have registered via
 *      register_service before handing us this URL.
 *
 * All other URLs (external sites, mailto:, anchors) pass through
 * unchanged. Registration failures fall back silently to the original
 * URL so a transient backend hiccup doesn't break navigation.
 */
export async function toPublicServiceUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!/^https?:$/.test(parsed.protocol)) return rawUrl;

  // ── Form 1: local-port URL ────────────────────────────────────────
  if (parsed.port) {
    const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", INSTANCE_IP]);
    if (localHosts.has(parsed.hostname)) {
      return registerAndRewrite(parsed, Number(parsed.port));
    }
  }

  // ── Forms 2 & 3: platform URL ─────────────────────────────────────
  if (USER_ID && PLATFORM_DOMAIN) {
    const platformSuffix = `-${USER_ID}.${PLATFORM_DOMAIN}`;
    if (parsed.hostname.endsWith(platformSuffix)) {
      const name = parsed.hostname.slice(0, -platformSuffix.length);
      // Form 2 — auto-named, port is recoverable from the subdomain.
      const m = name.match(/^port-(\d+)$/);
      if (m) {
        const port = Number(m[1]);
        if (port >= 1 && port <= 65535) {
          // Fire-and-forget — the URL is already correct, we just want
          // to make sure the registration exists. Don't make the user
          // wait on the POST round-trip.
          void fetch(registerServiceUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ port }),
          }).catch(() => { /* ignore */ });
        }
      }
      // Form 3 (named) or form-2-but-malformed: trust the URL as-is.
      return rawUrl;
    }
  }

  // External URL — leave it alone.
  return rawUrl;
}

async function registerAndRewrite(parsed: URL, port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return parsed.toString();
  try {
    const res = await fetch(registerServiceUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (!res.ok) return parsed.toString();
    const data = (await res.json()) as { url?: string };
    if (!data.url) return parsed.toString();
    return `${data.url}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return parsed.toString();
  }
}
