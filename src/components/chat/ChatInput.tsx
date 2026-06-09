"use client";

import {
  ChangeEvent,
  KeyboardEvent,
  ClipboardEvent,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PermissionMode } from "../../types/types";

/* ============================================================
   Imperative handle — lets a parent (e.g. ChatPanel) push text
   into the composer without lifting the textarea state up.
   ============================================================ */

export type ChatInputHandle = {
  /** Replace the textarea content and focus it. */
  setDraft: (text: string) => void;
  /** Append text to the existing draft (with a blank line separator if
   *  there's already content). Used by the comments-on-snapshot flow so
   *  user-typed prompts don't get overwritten by the auto-generated
   *  annotation summary. */
  appendDraft: (text: string) => void;
  /** Add an image attachment to the composer (used by the annotation
   *  snapshot flow to drop a screenshot into the next message). */
  addImageAttachment: (file: File) => void;
};

/* ============================================================
   Types
   ============================================================ */

export type Attachment = {
  id: string;
  name: string;
  meta?: string; // e.g. "1828x1968" for images
  preview?: string; // data URL for image preview
  file: File;
  kind: "image" | "file";
};

export type SlashCommand =
  | "clear"
  | "history"
  | "project"
  | "help"
  | "ports"
  | "account"
  | "usage"
  | "logout";

type ChatInputProps = {
  onSend: (message: string, attachments: Attachment[]) => void;
  onStop?: () => void;
  onSlashCommand?: (cmd: SlashCommand) => void;
  onAddEnvironmentPack?: () => void;
  isLoading: boolean;
  permissionMode: PermissionMode;
  onToggleMode: () => void;
  /** Whether tool calls / tool results / thinking blocks are visible in the
   *  message list. Controlled by the parent so it can also pass the same
   *  flag into ChatMessages. */
  showToolDetails: boolean;
  onToggleToolDetails: () => void;
};

/* ============================================================
   Slash command catalog
   ============================================================ */

const SLASH_COMMANDS: { cmd: SlashCommand; label: string; hint: string }[] = [
  { cmd: "clear", label: "/clear", hint: "Clear chat history" },
  { cmd: "history", label: "/history", hint: "Open session history" },
  { cmd: "project", label: "/project", hint: "Switch working directory" },
  { cmd: "ports", label: "/ports", hint: "List all running web servers" },
  { cmd: "account", label: "/account", hint: "Show the signed-in account" },
  { cmd: "usage", label: "/usage", hint: "Show this session's token usage" },
  { cmd: "logout", label: "/logout", hint: "Sign out of Claude (back to login screen)" },
  { cmd: "help", label: "/help", hint: "Insert a help prompt" },
];

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default",
  plan: "plan",
  acceptEdits: "auto",
  bypassPermissions: "bypass",
};

/* ============================================================
   Helpers
   ============================================================ */

function attachmentId() {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToAttachment(file: File): Promise<Attachment> {
  const kind: Attachment["kind"] = file.type.startsWith("image/") ? "image" : "file";
  const base: Attachment = {
    id: attachmentId(),
    name: file.name || (kind === "image" ? "pasted-image.png" : "file"),
    file,
    kind,
    meta: formatBytes(file.size),
  };

  if (kind !== "image") return base;

  // Read image as data URL + measure dimensions
  const preview = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });

  const meta = await new Promise<string>((resolve) => {
    if (!preview) return resolve(formatBytes(file.size));
    const img = new Image();
    img.onload = () => resolve(`${img.naturalWidth}×${img.naturalHeight}`);
    img.onerror = () => resolve(formatBytes(file.size));
    img.src = preview;
  });

  return { ...base, preview, meta };
}

/* ============================================================
   ChatInput
   ============================================================ */

const ChatInputImpl = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    onStop,
    onSlashCommand,
    onAddEnvironmentPack,
    isLoading,
    permissionMode,
    onToggleMode,
    showToolDetails,
    onToggleToolDetails,
  },
  ref
) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* --- Imperative API --- */

  useImperativeHandle(
    ref,
    () => ({
      setDraft: (value: string) => {
        setText(value);
        // Focus, place caret at end, and grow the textarea on the next frame
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(value.length, value.length);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
        });
      },
      appendDraft: (textToAppend: string) => {
        setText((prev) => {
          const trimmed = prev.replace(/\s+$/, "");
          return trimmed
            ? `${trimmed}\n\n${textToAppend}`
            : textToAppend;
        });
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
        });
      },
      addImageAttachment: (file: File) => {
        void (async () => {
          const att = await fileToAttachment(file);
          setAttachments((prev) => [...prev, att]);
          requestAnimationFrame(() => textareaRef.current?.focus());
        })();
      },
    }),
    []
  );

  /* --- Slash filtering --- */

  const slashQuery = useMemo(() => {
    if (!text.startsWith("/")) return null;
    const firstSpace = text.indexOf(" ");
    if (firstSpace >= 0) return null;
    return text.slice(1).toLowerCase();
  }, [text]);

  const filteredSlash = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) => c.cmd.includes(slashQuery) || c.label.slice(1).startsWith(slashQuery)
    );
  }, [slashQuery]);

  // Auto-open menu when "/" is the first char; close on space / non-slash
  useEffect(() => {
    if (slashQuery !== null && filteredSlash.length > 0) {
      setSlashOpen(true);
      setSlashIndex(0);
    } else if (slashQuery === null) {
      setSlashOpen(false);
    }
  }, [slashQuery, filteredSlash.length]);

  /* --- Attachments --- */

  const addAttachments = useCallback(async (files: File[] | FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    const items = await Promise.all(arr.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...items]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    void addAttachments(e.target.files);
    e.target.value = "";
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addAttachments(files);
    }
  };

  /* --- Send / commands --- */

  const runSlash = useCallback(
    (cmd: SlashCommand) => {
      setText("");
      setSlashOpen(false);
      if (cmd === "help") {
        setText("How do I use Claude Code? List the available features and slash commands.");
        return;
      }
      onSlashCommand?.(cmd);
    },
    [onSlashCommand]
  );

  const handleSend = useCallback(() => {
    if (slashOpen && filteredSlash.length > 0) {
      runSlash(filteredSlash[slashIndex].cmd);
      return;
    }
    const trimmed = text.trim();
    // NB: sending is allowed while a turn is in flight — the parent queues
    // the message instead of dropping it. Only empties are rejected here.
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [slashOpen, filteredSlash, slashIndex, runSlash, text, attachments, onSend]);

  /* --- Keyboard --- */

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + filteredSlash.length) % filteredSlash.length
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        runSlash(filteredSlash[slashIndex].cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  const openSlashMenu = () => {
    if (text && !text.startsWith("/")) {
      // don't clobber existing text
      return;
    }
    setText("/");
    setSlashOpen(true);
    setSlashIndex(0);
    textareaRef.current?.focus();
  };

  // Composing/sending stays enabled during a turn so the user can queue
  // follow-ups; the parent decides run-now vs enqueue. Only emptiness gates.
  const canSend = !!text.trim() || attachments.length > 0;

  return (
    <div className="composer">
      {/* --- Attachments row --- */}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <AttachmentPill key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}

      <div className="composer-input-wrap">
        {/* --- Slash menu popover --- */}
        {slashOpen && filteredSlash.length > 0 && (
          <div className="slash-menu" role="listbox" aria-label="Slash commands">
            {filteredSlash.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-item ${i === slashIndex ? "active" : ""}`}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runSlash(c.cmd);
                }}
              >
                <span className="slash-item-label">{c.label}</span>
                <span className="slash-item-hint">{c.hint}</span>
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-textarea"
          placeholder={
            isLoading ? "Queue another message…" : "Ask Claude to edit…"
          }
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={2}
          spellCheck={false}
        />

        <div className="composer-toolbar">
          {/* Left: + / */}
          <div className="composer-toolbar-left">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onFileInputChange}
            />
            <button
              type="button"
              className="tool-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              title={isLoading ? "Disabled while Claude is responding" : "Attach files"}
              aria-label="Attach files"
            >
              <IconPlus />
            </button>
            {onAddEnvironmentPack && (
              <button
                type="button"
                className="tool-icon-btn"
                onClick={onAddEnvironmentPack}
                disabled={isLoading}
                title={isLoading ? "Disabled while Claude is responding" : "Add environment pack"}
                aria-label="Add environment pack"
              >
                <IconPackage />
              </button>
            )}
            <button
              type="button"
              className="tool-icon-btn"
              onClick={openSlashMenu}
              disabled={isLoading}
              title={isLoading ? "Disabled while Claude is responding" : "Slash commands"}
              aria-label="Slash commands"
            >
              <IconSlash />
            </button>
          </div>

          {/* Right: tool-details toggle + mode + send.
              The eye toggle and mode chip stay enabled during a turn — they're
              view-only preferences (show/hide tool blocks) and the next-turn
              permission mode. Neither cancels or interferes with the in-flight
              stream, so locking them out forced users to wait pointlessly. */}
          <div className="composer-toolbar-right">
            <button
              type="button"
              className={`tool-icon-btn${showToolDetails ? " active" : ""}`}
              onClick={onToggleToolDetails}
              title={
                showToolDetails
                  ? "Hide tool details (tool calls, results, thinking)"
                  : "Show tool details (tool calls, results, thinking)"
              }
              aria-label="Toggle tool details visibility"
              aria-pressed={showToolDetails}
            >
              {showToolDetails ? <IconEye /> : <IconEyeOff />}
            </button>
            <button
              type="button"
              className="edit-mode-chip"
              data-mode={permissionMode}
              onClick={onToggleMode}
              title="Toggle permission mode (Ctrl+Shift+M)"
            >
              <IconCode />
              <span>{MODE_LABEL[permissionMode]}</span>
            </button>
            {isLoading && onStop ? (
              <button
                type="button"
                className="composer-send stop"
                onClick={onStop}
                title="Stop"
                aria-label="Stop"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <rect x="4" y="4" width="8" height="8" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                onClick={handleSend}
                disabled={!canSend}
                title="Send"
                aria-label="Send"
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Wrap ChatInput in React.memo so stream chunks bouncing through the
 * parent ChatPanel don't re-render the composer 60 times per second
 * during a long reply. Without this, the textarea repaints on every
 * rAF flush from streaming text — which is what made typing feel
 * sticky once a reply got going. Shallow comparison is enough because
 * ChatPanel routes its callbacks through useCallback already.
 */
export const ChatInput = memo(ChatInputImpl);

/* ============================================================
   Attachment pill
   ============================================================ */

function AttachmentPill({
  att,
  onRemove,
}: {
  att: Attachment;
  onRemove: () => void;
}) {
  return (
    <div className="attachment-pill" title={`${att.name}${att.meta ? ` · ${att.meta}` : ""}`}>
      {att.kind === "image" && att.preview ? (
        <img src={att.preview} alt="" className="attachment-thumb" />
      ) : (
        <span className="attachment-icon" aria-hidden>
          <IconFile />
        </span>
      )}
      <span className="attachment-name">{att.name}</span>
      {att.meta && <span className="attachment-meta">{att.meta}</span>}
      <button
        type="button"
        className="attachment-remove"
        onClick={onRemove}
        aria-label={`Remove ${att.name}`}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/* ============================================================
   Inline icons
   ============================================================ */

function IconPlus() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSlash() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11 3L5 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPackage() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5L13.5 4v8L8 14.5 2.5 12V4L8 1.5z M2.5 4L8 6.5 13.5 4 M8 6.5v8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCode() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconEye() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8C2.8 5.2 5.2 3.5 8 3.5s5.2 1.7 6.5 4.5c-1.3 2.8-3.7 4.5-6.5 4.5S2.8 10.8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 4.5C2.5 5.4 1.8 6.6 1.5 8c1.3 2.8 3.7 4.5 6.5 4.5 1.1 0 2.2-.3 3.1-.8 M14.5 8c-.4-.8-.9-1.5-1.5-2.1 M6 4c.6-.3 1.3-.5 2-.5 2.8 0 5.2 1.7 6.5 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M2 2l12 12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13V3M4 7l4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 1.5h6L13 5v9.5h-9.5v-13z M9.5 1.5V5H13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
