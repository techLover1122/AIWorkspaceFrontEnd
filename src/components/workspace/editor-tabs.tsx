"use client";

import {
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EditorTab, TabGroup } from "../../types/types";

const GROUP_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899"];

type ContextMenuState = {
  x: number;
  y: number;
  tabId: string;
  step: "main" | "color-picker";
};

type EditorTabsProps = {
  tabs: EditorTab[];
  activeTabId: string;
  groups: Record<string, TabGroup>;
  /** Tab ids whose iframe is currently fetching. Drives the sweep
   *  animation — see `.editor-tab.loading::before` in globals.css. */
  loadingTabIds?: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
  onTabDrop: (event: DragEvent<HTMLDivElement>, index: number) => void;
  onGroupCreate: (tabId: string, color: string) => void;
  onGroupAssign: (tabId: string, groupId: string) => void;
  onGroupRemove: (tabId: string) => void;
  onGroupToggle: (groupId: string) => void;
  onGroupRename: (groupId: string, label: string) => void;
};

export function EditorTabs({
  tabs,
  activeTabId,
  groups,
  loadingTabIds,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onTabDrop,
  onGroupCreate,
  onGroupAssign,
  onGroupRemove,
  onGroupToggle,
  onGroupRename,
}: EditorTabsProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click — skip if target is inside the menu
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [contextMenu]);

  // Focus rename input
  useEffect(() => {
    if (renamingGroup && renameInputRef.current) {
      renameInputRef.current.select();
    }
  }, [renamingGroup]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, step: "main", tabId });
  }, []);

  const commitRename = useCallback(
    (groupId: string) => {
      const val = renameValue.trim();
      if (val) onGroupRename(groupId, val);
      setRenamingGroup(null);
    },
    [renameValue, onGroupRename]
  );

  // Tab count per group (used for chip tooltip)
  const groupTabCounts = tabs.reduce<Record<string, number>>((acc, tab) => {
    if (tab.groupId) acc[tab.groupId] = (acc[tab.groupId] ?? 0) + 1;
    return acc;
  }, {});

  // Build the elements list, interleaving group chips before each group's first tab
  const elements: React.ReactNode[] = [];
  let prevGroupId: string | undefined;

  tabs.forEach((tab, index) => {
    const group = tab.groupId ? groups[tab.groupId] : undefined;
    const isGroupStart = group && tab.groupId !== prevGroupId;

    if (isGroupStart && group) {
      const count = groupTabCounts[group.id] ?? 0;
      elements.push(
        <div
          key={`chip-${group.id}`}
          className={`tab-group-chip${group.collapsed ? " collapsed" : ""}`}
          style={{ "--tab-group-color": group.color } as CSSProperties}
          onClick={() => onGroupToggle(group.id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setRenamingGroup(group.id);
            setRenameValue(group.label);
          }}
          title={`${group.label} — ${count} tab${count !== 1 ? "s" : ""} (click to ${group.collapsed ? "expand" : "collapse"})`}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onGroupToggle(group.id);
            }
          }}
        >
          {renamingGroup === group.id ? (
            <input
              ref={renameInputRef}
              className="tab-group-chip-input"
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(group.id)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") commitRename(group.id);
                if (e.key === "Escape") setRenamingGroup(null);
                e.stopPropagation();
              }}
            />
          ) : (
            <>
              <span className="tab-group-chip-label">{group.label}</span>
              <span className="tab-group-chip-arrow" aria-hidden>
                {group.collapsed ? "▶" : "▾"}
              </span>
            </>
          )}
        </div>
      );
    }

    if (!group?.collapsed) {
      elements.push(
        <div
          key={tab.id}
          role="button"
          tabIndex={0}
          draggable
          className={`editor-tab${activeTabId === tab.id ? " active" : ""}${loadingTabIds?.has(tab.id) ? " loading" : ""}`}
          style={
            group
              ? ({ "--tab-group-color": group.color } as CSSProperties)
              : undefined
          }
          data-group={group?.id}
          data-group-start={isGroupStart ? "" : undefined}
          onClick={() => onSelectTab(tab.id)}
          onContextMenu={(e) => handleContextMenu(e, tab.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectTab(tab.id);
            }
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/workspace-tab", String(index));
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => onTabDrop(e, index)}
        >
          {group && (
            <span
              className="tab-group-dot"
              style={{ backgroundColor: group.color }}
              aria-hidden
            />
          )}
          <span className="editor-tab-label">{tab.label}</span>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${tab.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onCloseTab(tab.id);
              }
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8m0-8l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      );
    }

    prevGroupId = tab.groupId;
  });

  // Context menu data
  const ctxTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : null;
  const ctxGroupId = ctxTab?.groupId;
  const ctxGroup = ctxGroupId ? groups[ctxGroupId] : null;
  const otherGroups = Object.values(groups).filter((g) => g.id !== ctxGroupId);
  const usedColors = new Set(Object.values(groups).map((g) => g.color));
  const availableColors = GROUP_COLORS.filter((c) => !usedColors.has(c));

  return (
    <div className="editor-tabs">
      {elements}
      <button
        type="button"
        className="tab-add"
        aria-label="Open new VS Code tab"
        onClick={onAddTab}
      >
        +
      </button>

      {contextMenu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {contextMenu.step === "main" ? (
            <>
              <button
                type="button"
                className="tab-context-item"
                onClick={() =>
                  setContextMenu((prev) => prev && { ...prev, step: "color-picker" })
                }
              >
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M8 3v10M3 8h10"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                Add to new group
              </button>

              {otherGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="tab-context-item"
                  onClick={() => {
                    onGroupAssign(contextMenu.tabId, g.id);
                    setContextMenu(null);
                  }}
                >
                  <span
                    className="tab-context-color-dot"
                    style={{ backgroundColor: g.color }}
                  />
                  Move to {g.label}
                </button>
              ))}

              {ctxGroup && (
                <>
                  <div className="tab-context-separator" />
                  <button
                    type="button"
                    className="tab-context-item tab-context-danger"
                    onClick={() => {
                      onGroupRemove(contextMenu.tabId);
                      setContextMenu(null);
                    }}
                  >
                    Remove from group
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="tab-context-label">Choose color</div>
              <div className="tab-context-colors">
                {availableColors.length === 0 ? (
                  <span className="tab-context-label" style={{ padding: "0 2px" }}>
                    All colors in use
                  </span>
                ) : (
                  availableColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className="tab-context-color-btn"
                      style={{ backgroundColor: color }}
                      title={color}
                      onClick={() => {
                        onGroupCreate(contextMenu.tabId, color);
                        setContextMenu(null);
                      }}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
