// Visual patterns adapted from t3code apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx
// and ComposerPendingApprovalActions.tsx (MIT): a compact card, the request on one line, the
// options as buttons.
import { useEffect, useRef } from "react";
import { ShieldQuestion, Wrench } from "lucide-react";
import type { PermissionRequest } from "@/lib/daemon";
import { answerPermission } from "@/lib/daemon";
import { permissionKeyAllowed } from "@/lib/permission-keys";
import { iconByKind } from "./ToolCallRow";
import { primaryButton, quietButton, solidButton } from "@/components/ui/controls";

const verbByKind: Record<string, string> = {
  edit: "Allow this edit?",
  delete: "Allow deleting this file?",
  move: "Allow moving this file?",
  execute: "Allow this command?",
  fetch: "Allow this request?",
  read: "Allow reading this file?",
};

/** L4: shown inline at the end of the turn that waits on session/request_permission. */
export function PermissionCard({
  request,
  onOpenPath,
  keyboard = true,
}: {
  request: PermissionRequest;
  onOpenPath?: ((path: string) => void) | undefined;
  keyboard?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter only. Esc is not an answer: it used to send "cancelled", which stops the whole turn,
      // and a stray second Esc (after closing a popover or a card) killed the agent's work. Reject
      // declines one call with its button; stopping the agent is the composer's Stop.
      if (e.key !== "Enter") return;
      // Only when the key can't mean anything else (lib/permission-keys.ts): Enter on a button —
      // Home's "Open …" or "Reject", a dialog, a menu, a field — is that control's, never an answer.
      if (!permissionKeyAllowed(e, { body: document.body, root: document.documentElement, card: cardRef.current })) return;
      const allow = request.options.find((o) => o.kind === "allow_once");
      if (!allow) return;
      e.preventDefault();
      answerPermission(request.requestId, allow.optionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, keyboard]);

  const call = request.toolCall;
  const Icon = iconByKind[call.kind] ?? Wrench;
  const loc = call.locations[0];
  const primary =
    request.options.find((o) => o.kind === "allow_once") ??
    request.options.find((o) => o.kind.startsWith("allow"));

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Permission request"
      className="rounded-xl border border-warn/35 bg-surface-1 p-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md pill-warn">
          <ShieldQuestion className="size-3.5" />
        </span>
        <p className="text-ui font-medium text-foreground">
          {verbByKind[call.kind] ?? "Allow this action?"}
        </p>
        {keyboard ? (
          <span className="ms-auto hidden shrink-0 items-center gap-1 text-caption text-faint sm:flex">
            <kbd className="kbd">⏎</kbd> allow
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 flex min-w-0 items-center gap-2 rounded-lg bg-background px-2.5 py-1.5 ring-1 ring-hairline">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-ui-sm text-foreground/90" title={call.title}>
          {call.title}
        </span>
        {loc && !call.title.includes(loc.path) ? (
          <button
            type="button"
            onClick={() => onOpenPath?.(loc.path)}
            title={`Open ${loc.path}`}
            className="min-w-0 shrink truncate font-mono text-caption text-primary hover:underline"
          >
            {loc.path}
          </button>
        ) : null}
      </div>
      {call.command ? (
        <pre className="mt-1.5 max-h-20 overflow-auto rounded-lg bg-background px-2.5 py-1.5 font-mono text-meta whitespace-pre-wrap text-foreground/85 ring-1 ring-hairline">
          $ {call.command}
        </pre>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {request.options.map((o) => {
          const isPrimary = o.optionId === primary?.optionId;
          return (
            <button
              key={o.optionId}
              type="button"
              disabled={request.answering}
              onClick={() => answerPermission(request.requestId, o.optionId)}
              className={isPrimary ? primaryButton : o.kind.startsWith("reject") ? quietButton : solidButton}
            >
              {o.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
