/**
 * Resolve the host the user's browser uses to reach our services.
 * Defaults to `localhost` for local dev; on EC2 / staging, set
 * `NEXT_PUBLIC_INSTANCE_IP` to the public IP (or hostname) so URLs
 * embedded in the bundle point at the real machine.
 *
 * Port numbers stay per-service — only the host part is variable.
 */
export const INSTANCE_IP = process.env.NEXT_PUBLIC_INSTANCE_IP ?? "localhost";

/**
 * The workspace owner's user id (Mongo _id, 24-char hex). Used to recognise
 * platform-internal URLs of the form `<service>-<USER_ID>.<PLATFORM_DOMAIN>`
 * so we can ensure they're registered before opening as a tab.
 *
 * Empty string in dev — the platform-URL detection in registerService.ts
 * is gated on this being non-empty.
 */
export const USER_ID = process.env.NEXT_PUBLIC_USER_ID ?? "";

/**
 * Apex domain this workspace lives under (e.g. `platform.bytescripterz.com`).
 * Same purpose as USER_ID — used to detect platform-internal URLs.
 */
export const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? "";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? `http://${INSTANCE_IP}:8090`;

export function statusUrl(): string {
  return `${BACKEND_URL}/api/status`;
}

export function setApiKeyUrl(): string {
  return `${BACKEND_URL}/api/auth/api-key`;
}

export function clearAuthUrl(): string {
  return `${BACKEND_URL}/api/auth/clear`;
}

export function subscriptionStartUrl(): string {
  return `${BACKEND_URL}/api/auth/subscription/start`;
}

export function subscriptionStatusUrl(): string {
  return `${BACKEND_URL}/api/auth/subscription/status`;
}

export function subscriptionCancelUrl(): string {
  return `${BACKEND_URL}/api/auth/subscription/cancel`;
}

export function subscriptionSubmitCodeUrl(): string {
  return `${BACKEND_URL}/api/auth/subscription/submit-code`;
}

export function chatUrl(): string {
  return `${BACKEND_URL}/api/chat`;
}

/** GET endpoint that streams events for an existing task. Use `from=<seq>`
 *  to resume after a reconnect without losing or duplicating events. */
export function chatStreamUrl(taskId: string, fromSeq: number = 0): string {
  return `${BACKEND_URL}/api/chat/stream/${encodeURIComponent(taskId)}?from=${fromSeq}`;
}

/** List active background chat tasks (optionally scoped to a working
 *  directory) so the frontend can auto-reattach on workspace open. */
export function chatActiveTasksUrl(workingDirectory?: string): string {
  if (!workingDirectory) return `${BACKEND_URL}/api/chat/active`;
  return `${BACKEND_URL}/api/chat/active?workingDirectory=${encodeURIComponent(workingDirectory)}`;
}

export function abortUrl(requestId: string): string {
  return `${BACKEND_URL}/api/abort/${requestId}`;
}

export function projectsUrl(): string {
  return `${BACKEND_URL}/api/projects`;
}

export function historiesUrl(encodedName: string): string {
  return `${BACKEND_URL}/api/projects/${encodedName}/histories`;
}

export function conversationUrl(encodedName: string, sessionId: string): string {
  return `${BACKEND_URL}/api/projects/${encodedName}/histories/${sessionId}`;
}

export function portScanUrl(): string {
  return `${BACKEND_URL}/api/ports/scan`;
}

export function logTabUrl(): string {
  return `${BACKEND_URL}/api/tabs/log`;
}

export function registerServiceUrl(): string {
  return `${BACKEND_URL}/api/services`;
}

export function listServicesUrl(): string {
  return `${BACKEND_URL}/api/services`;
}

export function urlsUrl(): string {
  return `${BACKEND_URL}/api/urls`;
}

export function urlByIdUrl(id: number): string {
  return `${BACKEND_URL}/api/urls/${id}`;
}

export function openedUrlsUrl(): string {
  return `${BACKEND_URL}/api/urls/opened`;
}

export function setOpenedUrl(): string {
  return `${BACKEND_URL}/api/urls/opened`;
}

export function eventsUrl(): string {
  return `${BACKEND_URL}/api/events`;
}

/**
 * WebSocket URL for the PTY-backed terminal. We derive ws(s):// from the
 * backend's http(s):// scheme so the same INSTANCE_IP / PLATFORM_DOMAIN
 * routing applies — Traefik proxies the upgrade through transparently.
 */
export function terminalWsUrl(): string {
  const u = new URL(BACKEND_URL);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/api/terminal`;
}

export function installPackUrl(): string {
  return `${BACKEND_URL}/api/packs/install`;
}

/* ────── Local project upload + auto-run ──────
   Upload posts zip bytes; the server extracts under ~/.ai-ide/projects/,
   then /run detects + starts the project and streams output over SSE. */
export function uploadProjectUrl(name: string): string {
  return `${BACKEND_URL}/api/projects/upload?name=${encodeURIComponent(name)}`;
}

export function runProjectUrl(): string {
  return `${BACKEND_URL}/api/projects/run`;
}

export function runProjectStreamUrl(runId: string): string {
  return `${BACKEND_URL}/api/projects/run/${encodeURIComponent(runId)}/stream`;
}

export function permissionDecisionUrl(id: string): string {
  return `${BACKEND_URL}/api/permission/${id}`;
}

export function intentGuardUrl(id: string): string {
  return `${BACKEND_URL}/api/intent-guard/${id}`;
}

/* ────── WhatsApp integration ──────
   These proxy through the backend (handlers/whatsapp.ts) to the Go
   sidecar (ai-ide-whatsapp.service on 127.0.0.1:8091). Polling /qr
   every couple seconds is how the modal stays current while the user
   scans on their phone. */
export function whatsappStatusUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/status`;
}
export function whatsappQrUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/qr`;
}
export function whatsappPairPhoneUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/pair-phone`;
}
export function whatsappUnlinkUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/unlink`;
}
export function whatsappRecipientUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/recipient`;
}
export function whatsappForwardingUrl(): string {
  return `${BACKEND_URL}/api/whatsapp/forwarding`;
}

export { BACKEND_URL };
