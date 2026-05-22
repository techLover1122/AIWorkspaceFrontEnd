/**
 * Resolve the host the user's browser uses to reach our services.
 * Defaults to `localhost` for local dev; on EC2 / staging, set
 * `NEXT_PUBLIC_INSTANCE_IP` to the public IP (or hostname) so URLs
 * embedded in the bundle point at the real machine.
 *
 * Port numbers stay per-service — only the host part is variable.
 */
export const INSTANCE_IP = process.env.NEXT_PUBLIC_INSTANCE_IP ?? "localhost";

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

export function installPackUrl(): string {
  return `${BACKEND_URL}/api/packs/install`;
}

export function permissionDecisionUrl(id: string): string {
  return `${BACKEND_URL}/api/permission/${id}`;
}


export { BACKEND_URL };
