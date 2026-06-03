"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { terminalWsUrl } from "../../constant/api";

/**
 * Workspace terminal — PTY-backed shell rendered with xterm.js. The
 * backend (handlers/terminal.ts) spawns one node-pty per connection
 * and bridges stdio over WebSocket. Theme is tuned to match the chat
 * panel's accent palette (blue cursor / selection, green success-y
 * tones) so it sits in the same visual family as the rest of the IDE.
 *
 * Auto-reconnect: WebSocket drops are normal — Traefik / nginx /
 * Cloudflare all close idle connections eventually, even with our
 * server-side ping (laptop sleep, brief network glitches, container
 * restarts). On `close` we re-dial with exponential backoff up to
 * 5 attempts. The xterm instance is preserved across reconnects, so
 * scrollback survives; the underlying PTY is a fresh shell each time
 * (we don't have session-resume on the backend yet).
 */
export function TerminalView() {
  const containerRef = useRef<HTMLDivElement>(null);
  // The whole xterm + WS lifecycle is owned by a single effect so the
  // cleanup function can tear everything down in the right order
  // (observer → ws → terminal). Refs are only used to defend against
  // React 18 StrictMode double-mounting in dev.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: false,
      // Theme: matches the chat panel — dark background, accent blue
      // cursor + selection, the rest follows the VS Code Dark+ ANSI
      // palette so familiar tools (ls, git, htop) look right.
      theme: {
        background: "#1b1b1f",
        foreground: "#d4d4d4",
        cursor: "#3794ff",
        cursorAccent: "#1b1b1f",
        selectionBackground: "rgba(55, 148, 255, 0.32)",
        selectionForeground: "#ffffff",
        black: "#1b1b1f",
        red: "#f48771",
        green: "#73c991",
        yellow: "#dcdcaa",
        blue: "#3794ff",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#666666",
        brightRed: "#ff8a73",
        brightGreen: "#8ddba1",
        brightYellow: "#e6e6a3",
        brightBlue: "#5aa9ff",
        brightMagenta: "#d8a0d0",
        brightCyan: "#6ad9c8",
        brightWhite: "#ffffff",
      },
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(container);
    // First fit before we connect so the initial PTY resize message
    // carries the real dimensions rather than the 80x24 default.
    try {
      fit.fit();
    } catch {
      // Container has zero size on the first paint — onResize observer
      // will retry once layout settles.
    }

    // Reconnect bookkeeping — kept inside the effect so each mount has
    // its own counters; on unmount they're discarded with the closure.
    let cancelled = false;
    let reconnectAttempt = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    let currentWs: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const sendIfOpen = (payload: unknown): void => {
      if (currentWs?.readyState === WebSocket.OPEN) {
        try {
          currentWs.send(JSON.stringify(payload));
        } catch {
          // dropped between check and send — the close handler will retry
        }
      }
    };

    const connect = (): void => {
      if (cancelled) return;

      const ws = new WebSocket(terminalWsUrl());
      currentWs = ws;

      ws.addEventListener("open", () => {
        if (cancelled) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        reconnectAttempt = 0;
        if (reconnectAttempt > 0) {
          // After a successful reconnect, write a thin separator so the
          // user can see where the new shell session started.
          term.write("\r\n\x1b[2m── reconnected ──\x1b[0m\r\n");
        }
        // Tell the new PTY about the current viewport size.
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      });

      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data) as {
            type?: string;
            data?: string;
            code?: number | null;
          };
          if (msg.type === "data" && typeof msg.data === "string") {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            term.write(
              `\r\n\x1b[2m[process exited with code ${msg.code ?? 0}]\x1b[0m\r\n`
            );
          } else if (msg.type === "error" && typeof msg.data === "string") {
            term.write(`\x1b[31m${msg.data}\x1b[0m`);
          }
        } catch {
          // Non-JSON frame — ignore (shouldn't happen with our backend).
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled) return;
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          term.write(
            "\r\n\x1b[31m[connection lost — max reconnect attempts reached. " +
              "Refresh the tab to try again.]\x1b[0m\r\n"
          );
          return;
        }
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s. Gives transient
        // proxy/network blips room to settle without spamming the
        // backend with reconnects.
        const delay = Math.min(16_000, 1_000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        term.write(
          `\r\n\x1b[2m[connection closed — reconnecting in ${Math.round(
            delay / 1_000
          )}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})…]\x1b[0m\r\n`
        );
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });

      ws.addEventListener("error", () => {
        // Errors trigger a close right after, so let the close handler
        // own the reconnect path — don't double-fire.
      });
    };

    const dataDisposable = term.onData((data) => {
      sendIfOpen({ type: "data", data });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendIfOpen({ type: "resize", cols, rows });
    });

    // Refit whenever the container resizes — including the very first
    // resize once layout has been painted (catches the zero-size case
    // above) and any sidebar drag that changes the chat-panel width.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // mid-unmount or detached — fine
      }
    });
    ro.observe(container);

    connect();

    return () => {
      cancelled = true;
      ro.disconnect();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try {
        currentWs?.close();
      } catch {
        // already closed
      }
      try {
        term.dispose();
      } catch {
        // already disposed
      }
    };
  }, []);

  return <div ref={containerRef} className="terminal-view" />;
}
