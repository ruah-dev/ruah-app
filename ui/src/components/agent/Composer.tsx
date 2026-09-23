// Visual patterns adapted from t3code apps/web/src/components/chat/ComposerSurface.tsx and
// ComposerPrimaryActions.tsx (MIT): a rounded surface, auto-growing textarea, controls in the
// bottom row, a round send / stop button on the right.
import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { onComposerDraft, takeComposerDraft } from "@/lib/composer-draft";
import { ArrowUp, AtSign, Loader2, Paperclip, Square, X } from "lucide-react";
import type { AttachmentMeta } from "@/lib/contracts";
import type { DiagramNode } from "@/data/graphs";
import { kindStyles } from "@/components/explorer/kinds";
import {
  MAX_ATTACHMENTS,
  agentTakesImages,
  setAgent,
  setAgentMode,
  setAgentModel,
  setModel,
  type DaemonState,
} from "@/lib/daemon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AttachmentStrip,
  ImageLightbox,
  formatBytes,
  isImageFile,
  useComposerAttachments,
} from "./Attachments";
import { consumeModelPickerRequest, onModelPickerRequest } from "@/lib/bus";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AgentModelPicker, ModePicker } from "./ComposerControls";

const MAX_HEIGHT = 220;

export type ComposerHandle = {
  focus: () => void;
  /** Attach dropped / picked files (non-images are skipped with a notice). */
  addFiles: (files: File[]) => void;
};

type Props = {
  node: DiagramNode | null;
  contextPath: string;
  daemon: DaemonState;
  running: boolean;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  onStop: () => void;
  /** Removing the context chip clears the selection. */
  onClearContext?: (() => void) | undefined;
  /** When set and nothing is selected, show an "Add context" button. */
  onPickContext?: (() => void) | undefined;
  /** This composer owns the global ⌘. shortcut (only one mounted composer should). */
  keyboard?: boolean;
};

/** Why images cannot be attached right now, or null. */
export function imageBlockedReason(daemon: DaemonState): string | null {
  const agents = daemon.agent?.agents;
  const name =
    agents?.available.find((a) => a.id === agents.currentAgentId)?.name ??
    daemon.agent?.agent?.name ??
    "This agent";
  const takes = agentTakesImages(daemon);
  if (takes === false) return `${name} can't read images — switch to Claude Code to attach screenshots`;
  if (takes === null) return `Waiting for ${name} to say whether it reads images…`;
  return null;
}

/** Why the composer cannot send right now, or null. Shown quietly under the surface. */
function blockedReason(daemon: DaemonState): string | null {
  if (daemon.source === "sample")
    return "No Ruah daemon connected — run `archmap serve <repo>` and open the page it serves to chat.";
  if (daemon.source === null || daemon.connection === "connecting") return "Connecting to the daemon…";
  if (daemon.connection !== "open") return "Daemon disconnected — reconnecting…";
  if (daemon.agent?.state === "error")
    return `The agent failed to start${daemon.agent.error ? `: ${daemon.agent.error}` : "."}`;
  if (daemon.agent?.state === "stopped") return "The agent is stopped.";
  return null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { node, contextPath, daemon, running, onSend, onStop, onClearContext, onPickContext, keyboard = true },
  ref,
) {
  const [draft, setDraft] = useState("");
  const [pendingAgent, setPendingAgent] = useState<{ agentId: string; modelId: string | null } | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  // ⌘. (global): open the agent · model picker of this composer.
  useEffect(() => {
    if (!keyboard) return;
    if (consumeModelPickerRequest()) setPickerOpen(true);
    return onModelPickerRequest(() => setPickerOpen(true));
  }, [keyboard]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const attachments = useComposerAttachments();
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [queued, setQueued] = useState(false);

  const reason = blockedReason(daemon);
  // Agent/model/mode choices need the socket, not a healthy agent: switching away from an
  // agent that failed to start must stay possible.
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const switching = daemon.agentSwitch;
  const inputDisabled = !!reason || running || !!switching;
  const imageReason = imageBlockedReason(daemon);
  const attachDisabled = inputDisabled || !!imageReason;
  const items = attachments.items;
  const uploading = items.some((i) => i.status === "uploading");
  const failed = items.some((i) => i.status === "error");
  // Images attached before switching to an agent that cannot read them block sending.
  const imagesBlocked = items.length > 0 && !!imageReason;
  const canSend =
    !inputDisabled && !!node && draft.trim().length > 0 && !failed && !imagesBlocked;

  const flash = (text: string | null) => {
    if (text) setNotice(text);
  };
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (inputDisabled) return;
    if (imageReason) {
      flash(imageReason);
      return;
    }
    flash(attachments.add(files));
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      addFiles: (files) => addFilesRef.current(files),
    }),
    [],
  );

  // "Draft … with the agent" elsewhere in the UI parks text for the composer (never auto-sent).
  useEffect(() => {
    const take = () => {
      const text = takeComposerDraft();
      if (text === null) return;
      setDraft(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    take();
    return onComposerDraft(take);
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [draft]);

  const doSend = () => {
    const sent: AttachmentMeta[] = attachments.items.flatMap((i) =>
      i.info ? [{ id: i.info.id, name: i.info.name, mimeType: i.info.mimeType }] : [],
    );
    onSend(draft.trim(), sent);
    setDraft("");
    setPreview(null);
    attachments.clear();
  };

  const submit = () => {
    if (!canSend) return;
    // Send waits for uploads still in flight.
    if (uploading) {
      setQueued(true);
      return;
    }
    doSend();
  };

  useEffect(() => {
    if (!queued || uploading) return;
    setQueued(false);
    if (canSend) doSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, uploading]);

  const requestAgent = (agentId: string, modelId: string | null = null) => {
    if (running) setPendingAgent({ agentId, modelId });
    else if (modelId) setAgentModel(agentId, modelId);
    else setAgent(agentId);
  };
  const pendingName = daemon.agent?.agents?.available.find(
    (a) => a.id === pendingAgent?.agentId,
  )?.name;

  const placeholder = switching
    ? `Starting ${switching.name}…`
    : running
      ? "The agent is working…"
      : reason
        ? connected
          ? "The agent is not ready"
          : "Chat needs a connected daemon"
        : node
          ? `Ask about ${node.label}…`
          : onPickContext
            ? "Add an element as context to ask about it"
            : "Select an element on the diagram to ask about it";

  const kind = node ? kindStyles[node.kind] : null;
  const KindIcon = kind?.icon;

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "composer-surface rounded-[20px] transition-shadow focus-within:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_55%,transparent),var(--elev-card)]",
          reason && "opacity-80",
        )}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,[role=menu]")) return;
          inputRef.current?.focus();
        }}
      >
        <AttachmentStrip
          items={items}
          onRemove={attachments.remove}
          onOpen={(i) => setPreview(i)}
        />
        {node ? (
          <div className="flex px-3 pt-2.5">
            <span
              className="group/chip flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-ai/10 ps-1.5 pe-1 text-[11.5px] text-foreground/90 ring-1 ring-ai/25"
              title={contextPath}
            >
              {KindIcon ? <KindIcon className={cn("size-3 shrink-0", kind!.color)} /> : null}
              <span className="min-w-0 truncate font-mono">@{contextPath}</span>
              {onClearContext ? (
                <button
                  type="button"
                  aria-label="Remove context"
                  onClick={onClearContext}
                  className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          </div>
        ) : onPickContext ? (
          <div className="flex px-3 pt-2.5">
            <button
              type="button"
              onClick={onPickContext}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <AtSign className="size-3" />
              Add context
            </button>
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          disabled={inputDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            // ⌘V of a screenshot: attach it instead of pasting nothing.
            const files = Array.from(e.clipboardData.files);
            if (!files.some(isImageFile)) return;
            e.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline; never while an IME is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Message the agent"
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-4 pt-2.5 pb-1 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span: a disabled button fires no pointer events, the tooltip still has to explain why */}
              <span className="inline-flex">
                <button
                  type="button"
                  aria-label="Attach images"
                  disabled={attachDisabled || items.length >= MAX_ATTACHMENTS}
                  onClick={() => fileRef.current?.click()}
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  <Paperclip className="size-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              {imageReason && !inputDisabled
                ? imageReason
                : items.length >= MAX_ATTACHMENTS
                  ? `Up to ${MAX_ATTACHMENTS} images per message`
                  : "Attach images — or paste (⌘V) or drop them here"}
            </TooltipContent>
          </Tooltip>
          <AgentModelPicker
            agents={connected ? daemon.agent?.agents : undefined}
            models={connected ? daemon.agent?.models : undefined}
            modelsByAgent={daemon.modelsByAgent}
            switching={switching}
            disabled={!connected || running}
            open={pickerOpen && connected && !running}
            onOpenChange={setPickerOpen}
            onModel={(id) => setModel(id)}
            onAgent={(id) => requestAgent(id)}
            onAgentModel={(id, modelId) => requestAgent(id, modelId)}
          />
          <ModePicker
            modes={connected && !switching ? daemon.agent?.modes : undefined}
            disabled={!!reason || running}
            onMode={setAgentMode}
          />
          <span className="flex-1" />
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={queued ? "Sending when the images are uploaded" : "Send message"}
              title={
                queued
                  ? "Sends when the images are uploaded"
                  : node
                    ? "Send (Enter)"
                    : "Select an element first"
              }
              disabled={!canSend || queued}
              onClick={submit}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-30"
            >
              {queued ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" strokeWidth={2.25} />
              )}
            </button>
          )}
        </div>
      </div>
      {reason ? (
        <p className="px-3 text-center text-[11.5px] text-faint">{reason}</p>
      ) : failed ? (
        <p className="px-3 text-center text-[11.5px] text-bad">
          An image failed to upload — remove it to send.
        </p>
      ) : imagesBlocked ? (
        <p className="px-3 text-center text-[11.5px] text-warn">{imageReason}</p>
      ) : notice ? (
        <p className="px-3 text-center text-[11.5px] text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      <ImageLightbox
        images={items.map((i) => ({
          src: i.previewUrl,
          name: i.name,
          detail:
            i.info?.width && i.info.height
              ? `${i.info.width}×${i.info.height} · ${formatBytes(i.size)}`
              : formatBytes(i.size),
        }))}
        index={preview}
        onIndexChange={setPreview}
      />

      <AlertDialog open={pendingAgent !== null} onOpenChange={(o) => !o && setPendingAgent(null)}>
        <AlertDialogContent className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="heading text-[15px]">
              Switch to {pendingName ?? "another agent"}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              This stops the current turn and starts a new session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-[13px]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 rounded-lg text-[13px]"
              onClick={() => {
                if (pendingAgent)
                  setAgentModel(pendingAgent.agentId, pendingAgent.modelId);
                setPendingAgent(null);
              }}
            >
              Switch agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
