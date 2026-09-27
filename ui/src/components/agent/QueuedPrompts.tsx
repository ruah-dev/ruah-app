// The prompts waiting for the running turn (lib/prompt-queue.ts), docked above the composer:
// each one can be edited in place or removed; a paused queue offers to go on.
import { useEffect, useRef, useState } from "react";
import { AtSign, ImageIcon, Pencil, Play, X } from "lucide-react";
import type { QueuedPrompt } from "@/lib/prompt-queue";
import { cn } from "@/lib/utils";

export function QueuedPrompts({
  items,
  paused,
  running,
  pathFor,
  onEdit,
  onRemove,
  onClear,
  onResume,
}: {
  items: readonly QueuedPrompt[];
  paused: boolean;
  running: boolean;
  pathFor: (nodeId: string | null) => string | null;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onResume: () => void;
}) {
  if (items.length === 0) return null;
  const status = paused
    ? "Paused — the last turn didn't finish cleanly"
    : running
      ? "Sends when the agent finishes"
      : "Sending…";
  return (
    <section aria-label="Queued messages" className="mb-1.5 rounded-2xl border border-hairline bg-surface-1 p-1.5">
      <div className="flex items-center gap-2 px-2 pt-0.5 pb-1">
        <span className="text-meta font-medium text-foreground/90">Queued · {items.length}</span>
        <span className={cn("min-w-0 flex-1 truncate text-meta", paused ? "text-warn" : "text-faint")}>{status}</span>
        {paused && !running ? (
          <button
            type="button"
            onClick={onResume}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-foreground transition-colors hover:bg-accent"
          >
            <Play className="size-3" />
            Send next
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          className="h-6 rounded-md px-1.5 text-meta text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Clear
        </button>
      </div>
      <ol className="space-y-1">
        {items.map((item, i) => (
          <QueuedRow
            key={item.id}
            index={i + 1}
            item={item}
            contextPath={pathFor(item.nodeId)}
            onEdit={(text) => onEdit(item.id, text)}
            onRemove={() => onRemove(item.id)}
          />
        ))}
      </ol>
    </section>
  );
}

function QueuedRow({
  index,
  item,
  contextPath,
  onEdit,
  onRemove,
}: {
  index: number;
  item: QueuedPrompt;
  contextPath: string | null;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.text);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const save = () => {
    onEdit(value);
    setEditing(false);
  };

  return (
    <li className="group/q flex items-start gap-2 rounded-xl bg-surface-2/60 px-2 py-1.5">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-ai/15 text-micro font-medium text-foreground/80">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={inputRef}
            value={value}
            rows={Math.min(6, Math.max(1, value.split("\n").length))}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setValue(item.text);
                setEditing(false);
              }
            }}
            aria-label={`Edit queued message ${index}`}
            className="block w-full resize-none rounded-md bg-background/60 px-1.5 py-1 text-ui-sm leading-relaxed text-foreground outline-none ring-1 ring-ring"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setValue(item.text);
              setEditing(true);
            }}
            title="Edit"
            className="block w-full text-left text-ui-sm leading-relaxed whitespace-pre-wrap text-foreground/90 line-clamp-3"
          >
            {item.text}
          </button>
        )}
        {contextPath || item.attachments.length > 0 ? (
          <div className="mt-0.5 flex items-center gap-2 text-meta text-faint">
            {contextPath ? (
              <span className="flex min-w-0 items-center gap-0.5 truncate font-mono">
                <AtSign className="size-3 shrink-0" />
                {contextPath}
              </span>
            ) : null}
            {item.attachments.length > 0 ? (
              <span className="flex items-center gap-0.5">
                <ImageIcon className="size-3" />
                {item.attachments.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {!editing ? (
        <button
          type="button"
          aria-label={`Edit queued message ${index}`}
          onClick={() => {
            setValue(item.text);
            setEditing(true);
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/q:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
        >
          <Pencil className="size-3" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove queued message ${index}`}
        onClick={onRemove}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </li>
  );
}
