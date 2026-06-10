"use client";

import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createInitialTabs } from "../../constant/constants";
import { logTabUrl, openedUrlsUrl, setOpenedUrl, urlsUrl, eventsUrl } from "../../constant/api";
import { toPublicServiceUrl } from "../../utils/registerService";
import { WorkspaceTabContext } from "../../contexts/WorkspaceTabContext";
import { getElectronTabs } from "../../utils/electronTabs";
import { ChatSessions } from "./chat-sessions";
import { EditorTabs } from "./editor-tabs";
import { EditorOverlayToolbar, type EditorOverlayTool } from "./editor-overlay-toolbar";
import {
  ProjectUpload,
  ProjectDropOverlay,
  type ProjectUploadHandle,
} from "./project-upload";
import {
  PreviewPane,
  type Drawing,
  type DrawingPoint,
  type Comment,
} from "./preview-pane";
import type { EditorTab, TabGroup } from "../../types/types";
import type { ChatInputHandle } from "../chat/ChatInput";
import {
  captureTabSnapshot,
  compositeSnapshotWithSvg,
} from "../../utils/captureIframeSnapshot";

type WorkspaceShellProps = {
  codeServerUrl: string;
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
};

const CHAT_WIDTH_KEY = "ai-ide:chat-panel-width";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH_RATIO = 0.7;
const TOOLBAR_VISIBLE_KEY = "ai-ide:overlay-toolbar-visible";

// Monotonic counter so tab IDs stay unique even when several are created
// inside the same millisecond — e.g. the openedUrls restore loop on mount,
// or rapid clicks on the "+" button. With plain `Date.now()` those collide
// and `activeTabId === tab.id` then matches multiple tabs simultaneously,
// which is what made the whole row look "active" in the bug report.
let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now()}-${tabIdCounter}`;
}

/** Convert a Windows path like D:\foo\bar → /mnt/d/foo/bar for WSL code-server. */
function toCodeServerPath(p: string): string {
  if (!p) return p;
  if (p.startsWith("/")) return p; // already a Linux/WSL path
  const m = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  return p;
}

function buildCodeServerUrl(base: string, workingDirectory?: string): string {
  if (!workingDirectory) return base;
  const folder = toCodeServerPath(workingDirectory);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}folder=${encodeURIComponent(folder)}`;
}

export function WorkspaceShell({
  codeServerUrl,
  workingDirectory,
  onChangeProject,
}: WorkspaceShellProps) {
  const [tabs, setTabs] = useState(() =>
    createInitialTabs(buildCodeServerUrl(codeServerUrl, workingDirectory))
  );
  const [activeTabId, setActiveTabId] = useState("vscode-1");

  // Mirror of `tabs` that's always up-to-date inside async handlers and
  // closures. State updaters run *later* than the surrounding code, so
  // logic like "does a tab with this URL already exist?" can't read from
  // the captured `tabs` variable (stale) and can't reliably set local
  // mutable state from inside an updater (the updater runs after the
  // surrounding setActiveTabId call). The ref dodges both pitfalls.
  const tabsRef = useRef<EditorTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Keep the VS Code tab in sync when the working directory changes.
  useEffect(() => {
    const url = buildCodeServerUrl(codeServerUrl, workingDirectory);
    setTabs((prev) =>
      prev.map((t) => (t.id === "vscode-1" ? { ...t, url } : t))
    );
  }, [workingDirectory, codeServerUrl]);
  const [groups, setGroups] = useState<Record<string, TabGroup>>({});
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  // Whether the floating overlay toolbar (refresh / marker / comments)
  // shows as the full strip or collapses down to a small chevron handle.
  // Persisted to localStorage so the user's choice survives reloads.
  const [toolbarVisible, setToolbarVisible] = useState(true);
  // Active overlay tool — applied to the active preview pane to switch the
  // user's cursor (marker / arrow) over the iframe. `null` means no tool is
  // selected and the iframe behaves normally.
  const [activeTool, setActiveTool] = useState<EditorOverlayTool | null>(null);
  // Marker strokes drawn over each tab's preview, keyed by tab id. Lives at
  // the workspace level so the strokes survive tab switches.
  const [drawingsByTab, setDrawingsByTab] = useState<Record<string, Drawing[]>>({});
  // Numbered comment pins per tab. Same lifecycle as drawings — cleared on
  // collapse, send, or tab close.
  const [commentsByTab, setCommentsByTab] = useState<Record<string, Comment[]>>({});
  const workspaceRef = useRef<HTMLElement>(null);

  // Local project upload (folder / .zip → extract + auto-run). The handle lets
  // the toolbar button and the global drop handler both drive one pipeline.
  const projectUploadRef = useRef<ProjectUploadHandle>(null);
  const [dropActive, setDropActive] = useState(false);
  // Counts dragenter/dragleave so nested children don't flicker the overlay.
  const dragDepthRef = useRef(0);

  // Annotation snapshot — per-tab data URL of the screen-captured iframe
  // pixels. While this is set for a tab, the PreviewPane swaps the live
  // iframe for the static snapshot + drawing canvas. Also drives whether
  // the overlay toolbar is expanded: no snapshot → collapsed handle, so a
  // cancelled permission prompt simply leaves the toolbar closed.
  const [snapshotByTab, setSnapshotByTab] = useState<Record<string, string>>({});
  // Set true around the actual frame grab so the toolbar / overlay UI can
  // hide itself out of the captured pixels.
  const [isCapturing, setIsCapturing] = useState(false);
  // Per-tab "iframe is fetching" flag. Toggled from PreviewPane's
  // `onLoadingChange` callback. Drives the tab-strip sweep animation
  // (.editor-tab.loading) — gated to actual fetches instead of running
  // forever on the active tab.
  const [loadingTabIds, setLoadingTabIds] = useState<Set<string>>(
    () => new Set()
  );
  const handleTabLoadingChange = useCallback(
    (tabId: string, loading: boolean) => {
      setLoadingTabIds((prev) => {
        if (loading === prev.has(tabId)) return prev;
        const next = new Set(prev);
        if (loading) next.add(tabId);
        else next.delete(tabId);
        return next;
      });
    },
    []
  );
  // Imperative handle into ChatInput so we can drop the composited snapshot
  // PNG as an attachment after Send.
  const chatInputRef = useRef<ChatInputHandle>(null);
  // PreviewPane reports its content host element + drawings <svg> via
  // `onElementsReady`. The host is the iframe in the browser-fallback path
  // and the .preview-content div in the Electron WebContentsView path —
  // both have the same on-screen rect, so capture / composite math is the
  // same regardless.
  const contentRefs = useRef<Record<string, HTMLElement | null>>({});
  const drawingSvgRefs = useRef<Record<string, SVGSVGElement | null>>({});

  const registerPreviewElements = useCallback(
    (
      tabId: string,
      els: { contentEl: HTMLElement | null; svg: SVGSVGElement | null }
    ) => {
      contentRefs.current[tabId] = els.contentEl;
      drawingSvgRefs.current[tabId] = els.svg;
    },
    []
  );

  // Reload the currently-active tab. In Electron mode this is a single IPC
  // round-trip to the WebContentsView (cleanest possible reload). In browser
  // mode we fall back to the "bounce iframe src through about:blank" trick
  // because cross-origin iframes can't be reloaded via contentWindow without
  // a SecurityError.
  const handleActiveTabReload = useCallback(() => {
    const electron = getElectronTabs();
    if (electron) {
      handleTabLoadingChange(activeTabId, true);
      electron.reload(activeTabId).catch(() => {});
      return;
    }
    const el = contentRefs.current[activeTabId];
    if (el && el instanceof HTMLIFrameElement) {
      const src = el.src;
      handleTabLoadingChange(activeTabId, true);
      el.src = "about:blank";
      requestAnimationFrame(() => { el.src = src; });
    }
  }, [activeTabId, handleTabLoadingChange]);

  const addDrawing = useCallback((targetTabId: string, points: DrawingPoint[]) => {
    setDrawingsByTab((prev) => ({
      ...prev,
      [targetTabId]: [
        ...(prev[targetTabId] ?? []),
        {
          id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          points,
        },
      ],
    }));
  }, []);

  const removeDrawing = useCallback((targetTabId: string, drawingId: string) => {
    setDrawingsByTab((prev) => ({
      ...prev,
      [targetTabId]: (prev[targetTabId] ?? []).filter((d) => d.id !== drawingId),
    }));
  }, []);

  const addComment = useCallback(
    (
      targetTabId: string,
      comment: { x: number; y: number; text: string }
    ) => {
      setCommentsByTab((prev) => ({
        ...prev,
        [targetTabId]: [
          ...(prev[targetTabId] ?? []),
          {
            id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            x: comment.x,
            y: comment.y,
            text: comment.text,
          },
        ],
      }));
    },
    []
  );

  const removeComment = useCallback(
    (targetTabId: string, commentId: string) => {
      setCommentsByTab((prev) => ({
        ...prev,
        [targetTabId]: (prev[targetTabId] ?? []).filter(
          (c) => c.id !== commentId
        ),
      }));
    },
    []
  );

  // Called when the overlay toolbar expands from its collapsed handle —
  // capture the active tab's currently-rendered pixels, freeze as a static
  // overlay, and arm the marker tool. Capture is a single IPC call to the
  // main process, which runs webContents.capturePage() on the tab's
  // WebContentsView — no permission prompt, no surface picker. The capture
  // path throws when running outside Electron (e.g. plain `npm run dev`).
  // Collapse / Send exits snapshot mode and restores the live content.
  const handleToolbarExpand = useCallback(async () => {
    const targetId = activeTabId;
    const contentEl = contentRefs.current[targetId];
    if (!contentEl) return;
    try {
      setIsCapturing(true);
      const dataUrl = await captureTabSnapshot({
        tabId: targetId,
        contentEl,
        onHideOverlays: () => setIsCapturing(true),
        onShowOverlays: () => setIsCapturing(false),
      });
      setSnapshotByTab((prev) => ({ ...prev, [targetId]: dataUrl }));
      setActiveTool("pointer");
    } catch {
      // User cancelled the picker, or capture failed — leave activeTool
      // null so the toolbar buttons un-press themselves.
      setActiveTool(null);
    } finally {
      setIsCapturing(false);
    }
  }, [activeTabId]);

  // Marker / comments need a frozen snapshot to draw on. The toolbar
  // calls onChangeTool directly with the requested tool; we wrap it so
  // that if no snapshot exists yet for this tab, we capture one first
  // and then arm the requested tool. Toggling off (tool === null) or
  // switching between tools when a snapshot already exists is a plain
  // setActiveTool call — no capture needed.
  const handleChangeTool = useCallback(
    (tool: EditorOverlayTool | null) => {
      const targetId = activeTabId;
      if (tool === null) {
        setActiveTool(null);
        return;
      }
      if (snapshotByTab[targetId]) {
        // Already have a snapshot — just swap the active tool.
        setActiveTool(tool);
        return;
      }
      // No snapshot yet — capture, then activeTool defaults to "pointer".
      // If the user clicked "comments" first, switch to it after capture.
      void (async () => {
        await handleToolbarExpand();
        if (tool !== "pointer") setActiveTool(tool);
      })();
    },
    [activeTabId, snapshotByTab, handleToolbarExpand]
  );

  const handleToolbarCollapse = useCallback(() => {
    const targetId = activeTabId;
    setActiveTool(null);
    setSnapshotByTab((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    // Discard drawings + comments tied to this snapshot session.
    setDrawingsByTab((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    setCommentsByTab((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
  }, [activeTabId]);

  const handleToolbarSend = useCallback(async () => {
    const targetId = activeTabId;
    const snapshot = snapshotByTab[targetId];
    if (!snapshot) return;
    const svg = drawingSvgRefs.current[targetId];
    const contentEl = contentRefs.current[targetId];
    const rect = contentEl?.getBoundingClientRect();
    const cssW = rect?.width ?? 1280;
    const cssH = rect?.height ?? 800;
    // Snapshot the comments for this tab before we clear them — we'll
    // turn them into a numbered prompt so the AI can map each pin in the
    // image back to the user's text instruction.
    const tabComments = commentsByTab[targetId] ?? [];
    try {
      const blob = await compositeSnapshotWithSvg(
        snapshot,
        svg,
        cssW,
        cssH
      );
      const file = new File(
        [blob],
        `annotation-${Date.now()}.png`,
        { type: "image/png" }
      );
      chatInputRef.current?.addImageAttachment(file);
      if (tabComments.length > 0) {
        const lines = tabComments.map(
          (c, i) => `${i + 1}. ${c.text}`
        );
        const summary =
          `On the attached screenshot, the numbered pins mark where I want ` +
          `changes. Please match each pin to the request below and update ` +
          `the corresponding code:\n\n` +
          lines.join("\n");
        chatInputRef.current?.appendDraft(summary);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to composite snapshot for chat", err);
    } finally {
      // Whether or not composite succeeded, exit snapshot mode — keeping
      // it open would just frustrate the user.
      setActiveTool(null);
      setSnapshotByTab((prev) => {
        if (!(targetId in prev)) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setDrawingsByTab((prev) => {
        if (!(targetId in prev)) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setCommentsByTab((prev) => {
        if (!(targetId in prev)) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
    }
  }, [activeTabId, snapshotByTab, commentsByTab]);

  useEffect(() => {
    const stored = window.localStorage.getItem(CHAT_WIDTH_KEY);
    if (!stored) return;
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) {
      const max = window.innerWidth * MAX_CHAT_WIDTH_RATIO;
      setChatWidth(Math.max(MIN_CHAT_WIDTH, Math.min(max, parsed)));
    }
  }, []);

  // ── Electron loading-state subscription ─────────────────────────────
  // In Electron mode, the iframe's `onLoad` callback is replaced by
  // did-start-loading / did-stop-loading events fired by the main process.
  // Subscribe once at mount; the unsubscribe handler is returned from the
  // preload API.
  useEffect(() => {
    const electron = getElectronTabs();
    if (!electron) return;
    return electron.onLoadingChange((tabId, loading) => {
      handleTabLoadingChange(tabId, loading);
    });
  }, [handleTabLoadingChange]);

  // ── Active-tab sync (Phase 5) ─────────────────────────────────────────
  // The renderer is the sole authority for which tab is active. Push every
  // change to main so MCP-side callers (and `tab:list`) can read it without
  // scraping the shell's DOM. No-op outside Electron.
  useEffect(() => {
    const electron = getElectronTabs();
    if (!electron) return;
    electron.setActive(activeTabId).catch(() => {});
  }, [activeTabId]);

  // ── Bounds contract (Electron mode) ─────────────────────────────────
  // The WebContentsView for the active tab is positioned by the main
  // process. We measure the editor-body div's rect on every layout change
  // (window resize, chat-panel resize, toolbar toggle, active tab change)
  // and forward it to main via tab.setBounds(activeTabId, rect).
  //
  // No-op in browser mode — the <iframe> lays itself out via DOM.
  const editorBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const electron = getElectronTabs();
    if (!electron) return;
    const el = editorBodyRef.current;
    if (!el) return;

    let rafId = 0;
    const push = () => {
      rafId = 0;
      const r = el.getBoundingClientRect();
      electron
        .setBounds(activeTabId, {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(push);
    };

    schedule(); // initial
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [activeTabId, chatWidth, toolbarVisible]);

  useEffect(() => {
    if (isResizing) return;
    window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(chatWidth)));
  }, [chatWidth, isResizing]);

  // Hydrate the toolbar-visible flag from localStorage on mount. "0" = hidden,
  // anything else (including missing) = visible. Stored as "0"/"1" so the
  // check stays cheap.
  useEffect(() => {
    const stored = window.localStorage.getItem(TOOLBAR_VISIBLE_KEY);
    if (stored === "0") setToolbarVisible(false);
  }, []);

  const toggleToolbarVisible = useCallback(() => {
    setToolbarVisible((v) => {
      const next = !v;
      window.localStorage.setItem(TOOLBAR_VISIBLE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const moveItem = <T,>(items: T[], fromIndex: number, toIndex: number) => {
    const nextItems = [...items];
    const [movedItem] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, movedItem);
    return nextItems;
  };

  const handleTabDrop = (event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    event.preventDefault();
    const sourceIndex = Number(event.dataTransfer.getData("text/workspace-tab"));
    if (Number.isNaN(sourceIndex) || sourceIndex === targetIndex) return;
    setTabs((currentTabs) => moveItem(currentTabs, sourceIndex, targetIndex));
  };

  // "+" button → open a blank new tab showing the new tab page.
  //
  // The id is generated OUTSIDE the setTabs updater on purpose. Two reasons:
  //   1. nextTabId() mutates a module-level counter — that's an impure side
  //      effect, so it can't live inside a state updater (React strict-mode
  //      runs updaters twice in dev, which would burn two ids per click and
  //      historically caused activeTabId to point at an id that didn't exist
  //      in the committed tabs array — the symptom was "+ doesn't open a new
  //      tab, it just keeps showing VS Code".)
  //   2. We need the same id for both setTabs and setActiveTabId so the new
  //      tab is actually selected the moment it's added.
  const handleAddTab = () => {
    const id = nextTabId();
    setTabs((currentTabs) => [
      ...currentTabs,
      { id, label: "New Tab", url: "" },
    ]);
    setActiveTabId(id);
  };

  // Ensure a URL exists in the SQLite `urls` bookmarks table (idempotent, fire-and-forget).
  const ensureBookmark = useCallback((url: string, name?: string) => {
    if (!url || url.startsWith("aiide://")) return;
    fetch(urlsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, name }),
    }).catch(() => { /* ignore */ });
  }, []);

  // Mark a URL opened/closed in the SQLite urls table (fire-and-forget).
  const markUrlOpened = useCallback((url: string, opened: boolean) => {
    if (!url || url.startsWith("aiide://")) return;
    fetch(setOpenedUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, opened }),
    }).catch(() => { /* ignore */ });
  }, []);

  // Called when user picks a URL from inside the new tab page (replaces the blank tab's URL).
  const handleTabNavigate = useCallback(
    (tabId: string, url: string, label: string) => {
      let prevUrl: string | undefined;
      setTabs((prev) => {
        const found = prev.find((t) => t.id === tabId);
        prevUrl = found?.url;
        return prev.map((t) => (t.id === tabId ? { ...t, url, label } : t));
      });
      if (prevUrl && prevUrl !== url) markUrlOpened(prevUrl, false);
      ensureBookmark(url, label);
      markUrlOpened(url, true);
      // Also log to opened_tabs history
      fetch(logTabUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, label, projectPath: workingDirectory }),
      }).catch(() => { /* ignore */ });
    },
    [markUrlOpened, ensureBookmark, workingDirectory]
  );

  // Called from chat / context — opens a URL in a new tab (or switches if already open).
  // Any caller (PortsView, chat, MCP open_tab SSE event) can pass a raw
  // ip:port URL; we translate it to the public domain URL here, registering
  // the port as a service if it isn't already. External URLs (no port, or
  // non-local host) pass through unchanged.
  const handleOpenTab = useCallback((rawUrl: string, label: string) => {
    void (async () => {
      const url = await toPublicServiceUrl(rawUrl);

      fetch(logTabUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, label, projectPath: workingDirectory }),
      }).catch(() => { /* ignore */ });
      ensureBookmark(url, label);
      markUrlOpened(url, true);

      // Match an already-open tab by base URL (scheme + host + port), not the
      // exact string — opening the same service at a different path / query
      // (e.g. Odoo /web vs /odoo) should focus the existing tab instead of
      // stacking a near-duplicate. Falls back to a normalized string compare
      // for non-URL schemes (aiide://terminal etc.).
      const baseOf = (u: string) => {
        try {
          return new URL(u).origin.toLowerCase();
        } catch {
          return u.trim().toLowerCase().replace(/\/+$/, "");
        }
      };
      const target = baseOf(url);

      // Look up an existing tab via the ref (always current), not via the
      // setTabs updater — the updater runs *after* the surrounding code, so
      // a value set inside it isn't yet readable by the setActiveTabId
      // call that follows.
      const existing = tabsRef.current.find((t) => t.url && baseOf(t.url) === target);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }

      const newId = nextTabId();
      setTabs((currentTabs) => {
        // Re-check under the latest committed state in case two open-tab
        // calls raced between the ref read above and this updater. Returns
        // currentTabs unchanged on a collision; setActiveTabId below still
        // points at `newId`, but the cleanup is bounded — at worst the
        // user lands on the duplicate's id which doesn't exist, and
        // activeTab.find falls back to tabs[0]. Rare in practice.
        if (currentTabs.some((t) => t.url && baseOf(t.url) === target)) return currentTabs;
        return [...currentTabs, { id: newId, label, url }];
      });
      setActiveTabId(newId);
    })();
  }, [workingDirectory, markUrlOpened, ensureBookmark]);

  // When running inside the Electron desktop app, open popups as workspace
  // tabs. The main process intercepts window.open() calls, routes them via
  // IPC, and the preload delivers them here via window.__AIIDE__.onOpenTab.
  useEffect(() => {
    const aiide = (window as unknown as { __AIIDE__?: { onOpenTab?: (cb: (url: string, label: string) => void) => () => void } }).__AIIDE__;
    if (!aiide?.onOpenTab) return;
    return aiide.onOpenTab((url, label) => handleOpenTab(url, label));
  }, [handleOpenTab]);

  // Restore previously open tabs on app load.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      try {
        const res = await fetch(openedUrlsUrl());
        if (!res.ok) return;
        const data = (await res.json()) as {
          urls: { id: number; name: string | null; url: string }[];
        };
        for (const u of data.urls) {
          handleOpenTab(u.url, u.name || u.url);
        }
      } catch { /* ignore */ }
    })();
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to backend SSE events — MCP tools push commands here
  // (e.g. when Claude calls `open_tab`, we receive it and act on it).
  useEffect(() => {
    const es = new EventSource(eventsUrl());
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as
          | { type: "hello" }
          | { type: "open_tab"; url: string; label: string }
          | { type: "bookmark_added"; url: string; name: string | null }
          | { type: "bookmark_deleted"; id: number };
        if (event.type === "open_tab") {
          handleOpenTab(event.url, event.label);
        }
        // bookmark events: new tab page re-fetches on focus, so no action needed here.
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCloseTab = (tabId: string) => {
    setTabs((currentTabs) => {
      if (currentTabs.length === 1) return currentTabs;

      const closingTab = currentTabs.find((t) => t.id === tabId);
      if (closingTab?.url) markUrlOpened(closingTab.url, false);
      const closingGroupId = closingTab?.groupId;
      const closingIndex = currentTabs.findIndex((t) => t.id === tabId);
      if (closingIndex === -1) return currentTabs;

      // Drop drawings + snapshot for the closing tab so they don't leak
      // memory across a long session.
      setDrawingsByTab((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setSnapshotByTab((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setCommentsByTab((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setLoadingTabIds((prev) => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
      delete contentRefs.current[tabId];
      delete drawingSvgRefs.current[tabId];

      const nextTabs = currentTabs.filter((t) => t.id !== tabId);

      setActiveTabId((currentActiveTabId) => {
        if (currentActiveTabId !== tabId) return currentActiveTabId;
        return nextTabs[closingIndex]?.id ?? nextTabs[closingIndex - 1]?.id ?? nextTabs[0].id;
      });

      if (closingGroupId) {
        const stillInGroup = nextTabs.some((t) => t.groupId === closingGroupId);
        if (!stillInGroup) {
          setGroups((prev) => {
            const next = { ...prev };
            delete next[closingGroupId];
            return next;
          });
        }
      }

      return nextTabs;
    });
  };

  const handleGroupCreate = useCallback((tabId: string, color: string) => {
    const groupId = `grp-${Date.now()}`;
    setGroups((prev) => {
      const count = Object.keys(prev).length + 1;
      return {
        ...prev,
        [groupId]: { id: groupId, label: `Group ${count}`, color, collapsed: false },
      };
    });
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, groupId } : t)));
  }, []);

  const handleGroupAssign = useCallback((tabId: string, groupId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, groupId } : t)));
  }, []);

  const handleGroupRemove = useCallback((tabId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      const removedGroupId = tab?.groupId;
      const nextTabs = prev.map((t) => (t.id === tabId ? { ...t, groupId: undefined } : t));
      if (removedGroupId) {
        const stillInGroup = nextTabs.some((t) => t.groupId === removedGroupId);
        if (!stillInGroup) {
          setGroups((g) => {
            const next = { ...g };
            delete next[removedGroupId];
            return next;
          });
        }
      }
      return nextTabs;
    });
  }, []);

  const handleGroupToggle = useCallback((groupId: string) => {
    setGroups((prev) => ({
      ...prev,
      [groupId]: { ...prev[groupId], collapsed: !prev[groupId].collapsed },
    }));
  }, []);

  const handleGroupRename = useCallback((groupId: string, label: string) => {
    setGroups((prev) => ({
      ...prev,
      [groupId]: { ...prev[groupId], label },
    }));
  }, []);

  /* ------------------------------------------------------------------
     Splitter drag
     ------------------------------------------------------------------ */

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setIsResizing(true);

    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();

    const onMove = (ev: PointerEvent) => {
      const max = rect.width * MAX_CHAT_WIDTH_RATIO;
      const next = Math.max(MIN_CHAT_WIDTH, Math.min(max, rect.right - ev.clientX));
      setChatWidth(next);
    };

    const onUp = (ev: PointerEvent) => {
      setIsResizing(false);
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }, []);

  const resetWidth = useCallback(() => {
    setChatWidth(DEFAULT_CHAT_WIDTH);
  }, []);

  /* ------------------------------------------------------------------
     Global project drag-and-drop. Only reacts to OS file drags (the
     "Files" type) — internal tab-reorder drags carry no files, so the
     existing handleTabDrop path is left untouched.
     ------------------------------------------------------------------ */

  const dragHasFiles = (e: DragEvent<HTMLElement>): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const handleWorkspaceDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);

  const handleWorkspaceDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleWorkspaceDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }, []);

  const handleWorkspaceDrop = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    // Pass the native DataTransfer straight through — the component resolves
    // webkitGetAsEntry() synchronously before any await.
    projectUploadRef.current?.handleDrop(e.dataTransfer);
  }, []);

  // Memoize the context value so we don't pass a fresh object literal
  // on every WorkspaceShell render — that would cascade through
  // useContext consumers (chat-panel.tsx in particular) and break
  // their useCallback/useMemo dep stability, defeating the ChatInput
  // memo and re-rendering the composer on every stream chunk.
  const tabContextValue = useMemo(
    () => ({ openTab: handleOpenTab, reloadActiveTab: handleActiveTabReload }),
    [handleOpenTab, handleActiveTabReload]
  );

  return (
    <WorkspaceTabContext.Provider value={tabContextValue}>
    <main
      className="app-shell"
      onDragEnter={handleWorkspaceDragEnter}
      onDragOver={handleWorkspaceDragOver}
      onDragLeave={handleWorkspaceDragLeave}
      onDrop={handleWorkspaceDrop}
    >
      {dropActive && <ProjectDropOverlay />}
      <ProjectUpload ref={projectUploadRef} onChangeProject={onChangeProject} />
      <section className="workspace-frame">
        <section
          ref={workspaceRef}
          className={`workspace ${isResizing ? "resizing" : ""}`}
          style={{ gridTemplateColumns: `minmax(0, 1fr) 4px ${chatWidth}px` }}
        >
          <section className="editor">
            {/* Phase 1 change: toolbar sits ABOVE the tab strip as part of
                the chrome. With WebContentsView tabs, anything floating over
                the content area gets occluded by the view (composited above
                the renderer), so floating-over-iframe positioning no longer
                works. Putting the toolbar in chrome keeps it visible. */}
            {/* Always render the toolbar row (except mid-capture) so its 36px
                height never collapses — switching to the URL-less "New Tab"
                page used to drop the whole row, which made the tools vanish
                and shifted the entire editor up. Annotation tools stay gated
                behind showAnnotationTools, so the blank page just shows the
                reload + hide controls instead of disappearing. */}
            {!isCapturing && (
              <EditorOverlayToolbar
                visible={toolbarVisible}
                onToggleVisible={toggleToolbarVisible}
                activeTool={activeTool}
                onChangeTool={handleChangeTool}
                onReload={handleActiveTabReload}
                onUploadProject={() => projectUploadRef.current?.openChooser()}
                showAnnotationTools={!!activeTab.url}
                onCollapse={handleToolbarCollapse}
                onSend={handleToolbarSend}
                hasSnapshot={!!snapshotByTab[activeTab.id]}
              />
            )}
            <EditorTabs
              tabs={tabs}
              activeTabId={activeTabId}
              groups={groups}
              loadingTabIds={loadingTabIds}
              onSelectTab={setActiveTabId}
              onCloseTab={handleCloseTab}
              onAddTab={handleAddTab}
              onTabDrop={handleTabDrop}
              onGroupCreate={handleGroupCreate}
              onGroupAssign={handleGroupAssign}
              onGroupRemove={handleGroupRemove}
              onGroupToggle={handleGroupToggle}
              onGroupRename={handleGroupRename}
              />
            <div className="editor-body" ref={editorBodyRef}>
              {/* Render every tab simultaneously and hide non-active ones via
                  `display:none` (handled inside PreviewPane). Keeps iframes
                  and any in-page state mounted across tab switches so the
                  user doesn't see a full reload when returning to a tab.
                  In Electron mode, the tab content is a main-process
                  WebContentsView composited above this div; each PreviewPane
                  only renders DOM overlays (snapshot, drawings, comments). */}
              {tabs.map((tab) => (
                <PreviewPane
                  key={tab.id}
                  tabId={tab.id}
                  url={tab.url}
                  codeServerUrl={codeServerUrl}
                  isActive={tab.id === activeTab.id}
                  // Only the active tab gets the tool overlay — inactive tabs
                  // shouldn't catch pointer events behind display:none anyway.
                  overlayTool={tab.id === activeTab.id ? activeTool : null}
                  drawings={drawingsByTab[tab.id]}
                  onAddDrawing={(points) => addDrawing(tab.id, points)}
                  onRemoveDrawing={(id) => removeDrawing(tab.id, id)}
                  comments={commentsByTab[tab.id]}
                  onAddComment={(c) => addComment(tab.id, c)}
                  onRemoveComment={(id) => removeComment(tab.id, id)}
                  snapshot={snapshotByTab[tab.id]}
                  onElementsReady={(els) =>
                    registerPreviewElements(tab.id, els)
                  }
                  onLoadingChange={handleTabLoadingChange}
                  onNavigate={handleTabNavigate}
                />
              ))}
            </div>
          </section>

          <div
            className={`workspace-splitter ${isResizing ? "active" : ""}`}
            onPointerDown={startResize}
            onDoubleClick={resetWidth}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            title="Drag to resize · Double-click to reset"
          />

          <ChatSessions
            workingDirectory={workingDirectory}
            onChangeProject={onChangeProject}
            chatInputRef={chatInputRef}
          />
        </section>
      </section>
    </main>
    </WorkspaceTabContext.Provider>
  );
}
