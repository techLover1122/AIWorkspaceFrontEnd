import { INSTANCE_IP, registerServiceUrl } from "../constant/api";

/**
 * Translate a "raw port" URL into its public domain equivalent by
 * registering the port as a service on the backend (which forwards to the
 * proxy router). Idempotent — calling twice for the same port returns the
 * same URL.
 *
 * Inputs that get translated:
 *   http://localhost:3000   →  http://frontend-<userId>.<domain>
 *   http://127.0.0.1:5173   →  http://port-5173-<userId>.<domain>
 *   http://<INSTANCE_IP>:N  →  same as above (whichever host is configured)
 *
 * Inputs that pass through unchanged: external URLs, URLs without a port,
 * non-http(s) protocols, and any URL whose host isn't one of the
 * workspace-local aliases.
 *
 * Registration failures fall back silently to the original URL so e.g.
 * external sites (wikipedia.org) keep working even if the backend is down.
 */
export async function toPublicServiceUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!/^https?:$/.test(parsed.protocol)) return rawUrl;
  if (!parsed.port) return rawUrl;

  const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", INSTANCE_IP]);
  if (!localHosts.has(parsed.hostname)) return rawUrl;

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return rawUrl;

  try {
    const res = await fetch(registerServiceUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (!res.ok) return rawUrl;
    const data = (await res.json()) as { url?: string };
    if (!data.url) return rawUrl;
    return `${data.url}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return rawUrl;
  }
}
