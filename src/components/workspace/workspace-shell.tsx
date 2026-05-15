"use client";

import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { createInitialTabs } from "../../constant/constants";
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

export function WorkspaceShell({
  codeServerUrl,
  workingDirectory,
  onChangeProject,
}: WorkspaceShellProps) {
  const [tabs, setTabs] = useState(() => createInitialTabs(codeServerUrl));
  const [activeTabId, setActiveTabId] = useState("vscode-1");
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

  const handleAddTab = () => {
    setTabs((currentTabs) => {
      const nextIndex = currentTabs.length + 1;
      const nextTab: EditorTab = {
        id: `vscode-${Date.now()}`,
        label: `VS Code ${nextIndex}`,
        url: codeServerUrl,
      };
      setActiveTabId(nextTab.id);
      return [...currentTabs, nextTab];
    });
  };

  const handleCloseTab = (tabId: string) => {
    setTabs((currentTabs) => {
      if (currentTabs.length === 1) return currentTabs;

      const closingTab = currentTabs.find((t) => t.id === tabId);
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
              <PreviewPane codeServerUrl={activeTab.url} />
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
  );
}
