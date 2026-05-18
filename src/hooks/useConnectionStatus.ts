"use client";

import { useCallback, useEffect, useState } from "react";
import {
  clearAuthUrl,
  setApiKeyUrl,
  statusUrl,
  subscriptionCancelUrl,
  subscriptionStartUrl,
  subscriptionStatusUrl,
  subscriptionSubmitCodeUrl,
} from "../constant/api";

export type SubscriptionPhase =
  | "idle"
  | "spawning"
  | "waiting_url"
  | "browser_opened"
  | "verifying"
  | "success"
  | "no_subscription"
  | "error"
  | "cancelled";

export type SubscriptionEvent = { t: number; msg: string };

export type SubscriptionStatus = {
  phase: SubscriptionPhase;
  url: string | null;
  urls?: string[];
  error: string | null;
  /** Captured CLI stdout/stderr — surfaced on error for diagnostics. */
  output?: string;
  /** Step-by-step log of the sign-in flow — rendered live in the modal. */
  events?: SubscriptionEvent[];
  /** True once the CLI has rendered (or is presumed to have rendered) the
   *  "Paste authorization code:" prompt. */
  readyForCode?: boolean;
  /** True if the user pasted a code before the CLI was ready and we have it
   *  queued. */
  pendingCode?: boolean;
  /** Stable id for the current PTY session — changes when a new sign-in
   *  attempt is started. */
  sessionId?: string | null;
};

export type SubmitCodeStatus = "submitted" | "pending" | "nudged" | "error";

const STORAGE_KEY = "aiide.claude-connected";

export type AuthMethod = "api_key" | "subscription" | null;

export type ConnectionState =
  | { status: "idle"; message?: string }
  | { status: "checking" }
  | {
      status: "connected";
      version?: string;
      cliPath?: string;
      authMethod?: AuthMethod;
      /** First-10 + last-4 of the API key, when authMethod === "api_key". */
      apiKeyMasked?: string | null;
    }
  | {
      status: "error";
      reason: string;
      message: string;
      cliReady?: boolean;
      authMethod?: AuthMethod;
    };

export type ApiKeyErrorCode =
  | "missing"
  | "format"
  | "invalid"
  | "forbidden"
  | "rate_limited"
  | "server"
  | "network";

export type ApiKeySubmitResult =
  | { ok: true }
  | { ok: false; code?: ApiKeyErrorCode; error: string };

export type ConnectionStatus = ConnectionState & {
  /** True only during the very first auto-check on mount (when a previous
   *  session was stored in localStorage). Lets the UI show a minimal
   *  "checking…" splash instead of the full ConnectScreen. */
  isInitialCheck: boolean;
  connect: () => Promise<void>;
  submitApiKey: (apiKey: string) => Promise<ApiKeySubmitResult>;
  disconnect: () => Promise<void>;
  /** Start subscription (OAuth) flow via spawned `claude login` on the backend. */
  startSubscriptionLogin: () => Promise<SubscriptionStatus>;
  /** Poll current subscription-login progress. */
  pollSubscriptionStatus: () => Promise<SubscriptionStatus>;
  /** Kill an in-progress subscription login. */
  cancelSubscriptionLogin: () => Promise<void>;
  /** Submit the authorization code/key shown by the OAuth page (or empty to continue). */
  submitSubscriptionCode: (code?: string) => Promise<{
    ok: boolean;
    status?: SubmitCodeStatus;
    message?: string;
    error?: string;
  }>;
};

type ServerResponse = {
  connected: boolean;
  cliPath?: string;
  version?: string;
  cliReady?: boolean;
  authMethod?: AuthMethod;
  apiKeyMasked?: string | null;
  reason?: string;
  message?: string;
};

/**
 * Gates the chat UI behind an explicit "Connect Claude" action.
 *
 * On mount: if the user has previously connected (flag in localStorage),
 * the connect check fires automatically so they don't see the connect screen
 * on every reload. If the flag isn't set, state stays "idle" and the UI
 * shows the connect screen.
 */
export function useConnectionStatus(): ConnectionStatus {
  const [state, setState] = useState<ConnectionState>({ status: "idle" });
  const [isInitialCheck, setIsInitialCheck] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const connect = useCallback(async () => {
    setState({ status: "checking" });
    try {
      const res = await fetch(statusUrl(), { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: ServerResponse = await res.json();
      if (data.connected) {
        try {
          window.localStorage.setItem(STORAGE_KEY, "1");
        } catch {
          /* localStorage unavailable */
        }
        setState({
          status: "connected",
          version: data.version,
          cliPath: data.cliPath,
          authMethod: data.authMethod ?? null,
          apiKeyMasked: data.apiKeyMasked ?? null,
        });
      } else {
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
        setState({
          status: "error",
          reason: data.reason ?? "unknown",
          message: data.message ?? "Could not reach Claude CLI",
          cliReady: data.cliReady,
          authMethod: data.authMethod ?? null,
        });
      }
    } catch (err) {
      setState({
        status: "error",
        reason: "network",
        message:
          err instanceof Error
            ? err.message
            : "Failed to reach the backend at /api/status",
      });
    }
  }, []);

  const submitApiKey = useCallback(
    async (apiKey: string): Promise<ApiKeySubmitResult> => {
      setState({ status: "checking" });
      try {
        const res = await fetch(setApiKeyUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const data: {
          ok: boolean;
          error?: string;
          code?: ApiKeyErrorCode;
        } = await res.json();
        if (!data.ok) {
          setState({
            status: "error",
            reason: `api_key_${data.code ?? "invalid"}`,
            message: data.error ?? "Invalid API key",
          });
          return {
            ok: false,
            code: data.code,
            error: data.error ?? "Invalid API key",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setState({ status: "error", reason: "network", message: msg });
        return { ok: false, code: "network", error: msg };
      }
      // Key accepted → re-check full status
      await connect();
      return { ok: true };
    },
    [connect]
  );

  const disconnect = useCallback(async () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    try {
      await fetch(clearAuthUrl(), { method: "POST" });
    } catch {
      /* ignore network */
    }
    setState({ status: "idle" });
  }, []);

  // Auto-reconnect on mount if user has connected before.
  useEffect(() => {
    let cancelled = false;
    let previouslyConnected = false;
    try {
      previouslyConnected =
        window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* ignore */
    }
    if (!previouslyConnected) {
      setIsInitialCheck(false);
      return;
    }
    void (async () => {
      setState({ status: "checking" });
      try {
        const res = await fetch(statusUrl(), { cache: "no-store" });
        const data: ServerResponse = await res.json();
        if (cancelled) return;
        if (data.connected) {
          setState({
            status: "connected",
            version: data.version,
            cliPath: data.cliPath,
            authMethod: data.authMethod ?? null,
            apiKeyMasked: data.apiKeyMasked ?? null,
          });
        } else {
          setState({
            status: "error",
            reason: data.reason ?? "unknown",
            message: data.message ?? "Could not reach Claude CLI",
            cliReady: data.cliReady,
            authMethod: data.authMethod ?? null,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          reason: "network",
          message:
            err instanceof Error ? err.message : "Backend unreachable",
        });
      } finally {
        if (!cancelled) setIsInitialCheck(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startSubscriptionLogin = useCallback(async (): Promise<SubscriptionStatus> => {
    try {
      const res = await fetch(subscriptionStartUrl(), { method: "POST" });
      return (await res.json()) as SubscriptionStatus;
    } catch (err) {
      return {
        phase: "error",
        url: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }, []);

  const pollSubscriptionStatus = useCallback(async (): Promise<SubscriptionStatus> => {
    try {
      const res = await fetch(subscriptionStatusUrl(), { cache: "no-store" });
      return (await res.json()) as SubscriptionStatus;
    } catch (err) {
      return {
        phase: "error",
        url: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }, []);

  const cancelSubscriptionLogin = useCallback(async () => {
    try {
      await fetch(subscriptionCancelUrl(), { method: "POST" });
    } catch {
      /* ignore */
    }
  }, []);

  const submitSubscriptionCode = useCallback(
    async (
      code?: string
    ): Promise<{ ok: boolean; status?: SubmitCodeStatus; message?: string; error?: string }> => {
      try {
        const res = await fetch(subscriptionSubmitCodeUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code ?? "" }),
        });
        return (await res.json()) as {
          ok: boolean;
          status?: SubmitCodeStatus;
          message?: string;
          error?: string;
        };
      } catch (err) {
        return { ok: false, status: "error", error: err instanceof Error ? err.message : "Network error" };
      }
    },
    []
  );

  return {
    ...state,
    isInitialCheck,
    connect,
    submitApiKey,
    disconnect,
    startSubscriptionLogin,
    pollSubscriptionStatus,
    cancelSubscriptionLogin,
    submitSubscriptionCode,
  } as ConnectionStatus;
}
