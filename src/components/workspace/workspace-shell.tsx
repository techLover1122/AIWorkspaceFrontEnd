"use client";

import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { createInitialTabs } from "../../constant/constants";
import { logTabUrl, openedUrlsUrl, setOpenedUrl, urlsUrl, eventsUrl } from "../../constant/api";
import { WorkspaceTabContext } from "../../contexts/WorkspaceTabContext";
import { ChatPanel } from "./chat-panel";
import { EditorTabs } from "./editor-tabs";
import { PreviewPane } from "./preview-pane";
import type { EditorTab, TabGroup } from "../../types/types";

type WorkspaceShellProps = {
  codeServerUrl: string;
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
};

const CHAT_WIDTH_KEY = "ai-ide:chat-panel-width";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH_RATIO = 0.7;

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
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(CHAT_WIDTH_KEY);
    if (!stored) return;
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) {
      const max = window.innerWidth * MAX_CHAT_WIDTH_RATIO;
      setChatWidth(Math.max(MIN_CHAT_WIDTH, Math.min(max, parsed)));
    }
  }, []);

  useEffect(() => {
    if (isResizing) return;
    window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(chatWidth)));
  }, [chatWidth, isResizing]);

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

  // "+" button → open a blank new tab showing the new tab page
  const handleAddTab = () => {
    setTabs((currentTabs) => {
      const nextTab: EditorTab = {
        id: nextTabId(),
        label: "New Tab",
        url: "",
      };
      setActiveTabId(nextTab.id);
      return [...currentTabs, nextTab];
    });
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
  const handleOpenTab = useCallback((url: string, label: string) => {
    // Side effects fire upfront (outside the state updater)
    fetch(logTabUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, label, projectPath: workingDirectory }),
    }).catch(() => { /* ignore */ });
    ensureBookmark(url, label);
    markUrlOpened(url, true);

    setTabs((currentTabs) => {
      const existing = currentTabs.find((t) => t.url === url);
      if (existing) {
        setActiveTabId(existing.id);
        return currentTabs;
      }
      const nextTab: EditorTab = { id: nextTabId(), label, url };
      setActiveTabId(nextTab.id);
      return [...currentTabs, nextTab];
    });
  }, [workingDirectory, markUrlOpened, ensureBookmark]);

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

  return (
    <WorkspaceTabContext.Provider value={{ openTab: handleOpenTab }}>
    <main className="app-shell">
      <section className="workspace-frame">
        <section
          ref={workspaceRef}
          className={`workspace ${isResizing ? "resizing" : ""}`}
          style={{ gridTemplateColumns: `minmax(0, 1fr) 4px ${chatWidth}px` }}
        >
          <section className="editor">
            <EditorTabs
              tabs={tabs}
              activeTabId={activeTabId}
              groups={groups}
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
            <div className="editor-body">
              {/* Render every tab simultaneously and hide non-active ones via
                  `display:none` (handled inside PreviewPane). Keeps iframes
                  and any in-page state mounted across tab switches so the
                  user doesn't see a full reload when returning to a tab. */}
              {tabs.map((tab) => (
                <PreviewPane
                  key={tab.id}
                  tabId={tab.id}
                  url={tab.url}
                  codeServerUrl={codeServerUrl}
                  isActive={tab.id === activeTab.id}
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

          <ChatPanel
            workingDirectory={workingDirectory}
            onChangeProject={onChangeProject}
          />
        </section>
      </section>
    </main>
    </WorkspaceTabContext.Provider>
  );
}
