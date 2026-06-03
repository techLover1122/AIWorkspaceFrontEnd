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

    const ws = new WebSocket(terminalWsUrl());

    ws.addEventListener("open", () => {
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
      term.write("\r\n\x1b[2m[connection closed]\x1b[0m\r\n");
    });

    ws.addEventListener("error", () => {
      term.write(
        "\r\n\x1b[31m[connection error — backend may be offline]\x1b[0m\r\n"
      );
    });

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
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

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try {
        ws.close();
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
