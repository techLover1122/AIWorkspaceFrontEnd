const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8090";

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

export { BACKEND_URL };
