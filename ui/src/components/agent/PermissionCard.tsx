// Visual patterns adapted from t3code apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx
// and ComposerPendingApprovalActions.tsx (MIT): a compact card, the request on one line, the
// options as buttons.
import { useEffect } from "react";
import { ShieldQuestion, Wrench } from "lucide-react";
import type { PermissionRequest } from "@/lib/daemon";
import { answerPermission } from "@/lib/daemon";
import { cn } from "@/lib/utils";
import { iconByKind } from "./ToolCallRow";

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
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A key meant for a dialog or menu (the new project wizard's Enter / Esc) never answers.
      if (e.defaultPrevented || target?.closest("[role=dialog], [role=menu], [role=alertdialog]")) return;
      if (
        target &&
        /input|textarea|select/i.test(target.tagName) &&
        !(target as HTMLTextAreaElement).disabled
      )
        return;
      if (e.key === "Enter") {
        const allow = request.options.find((o) => o.kind === "allow_once");
        if (!allow) return;
        e.preventDefault();
        answerPermission(request.requestId, allow.optionId);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        answerPermission(request.requestId, "cancel");
      }
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
      role="group"
      aria-label="Permission request"
      className="rounded-xl border border-warn/35 bg-surface-1 p-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-warn/15 text-warn">
          <ShieldQuestion className="size-3.5" />
        </span>
        <p className="text-[13px] font-medium text-foreground">
          {verbByKind[call.kind] ?? "Allow this action?"}
        </p>
        {keyboard ? (
          <span className="ms-auto hidden shrink-0 items-center gap-1 text-[11px] text-faint sm:flex">
            <kbd className="kbd">⏎</kbd> allow <kbd className="kbd ms-1">esc</kbd> dismiss
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 flex min-w-0 items-center gap-2 rounded-lg bg-background px-2.5 py-1.5 ring-1 ring-hairline">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[12.5px] text-foreground/90">{call.title}</span>
        {loc && !call.title.includes(loc.path) ? (
          <button
            type="button"
            onClick={() => onOpenPath?.(loc.path)}
            className="min-w-0 shrink truncate font-mono text-[11px] text-primary hover:underline"
          >
            {loc.path}
          </button>
        ) : null}
      </div>
      {call.command ? (
        <pre className="mt-1.5 max-h-20 overflow-auto rounded-lg bg-background px-2.5 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap text-foreground/85 ring-1 ring-hairline">
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
              className={cn(
                "h-7 rounded-lg px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                isPrimary
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : o.kind.startsWith("reject")
                    ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                    : "bg-surface-3 text-foreground hover:bg-surface-4",
              )}
            >
              {o.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
