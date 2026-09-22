import { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import type { PermissionRequest } from "@/lib/daemon";
import { answerPermission } from "@/lib/daemon";
import { Button } from "@/components/ui/button";
import { ToolCallRow } from "./ToolCallRow";

/** L4: pinned above the composer while a turn waits on session/request_permission. */
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

  return (
    <div className="control-glass space-y-2 rounded-md border border-primary/40 p-2.5">
      <p className="flex items-center gap-1.5 text-[9.5px] font-semibold text-muted-foreground uppercase">
        <ShieldAlert className="size-3.5 text-primary" />
        Permission needed
      </p>
      <ToolCallRow call={request.toolCall} onOpenPath={onOpenPath} />
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((o) => (
          <Button
            key={o.optionId}
            size="sm"
            variant={o.kind.startsWith("allow") ? "default" : "outline"}
            disabled={request.answering}
            onClick={() => answerPermission(request.requestId, o.optionId)}
            className="h-6 rounded-[4px] px-2 text-[11px]"
          >
            {o.name}
          </Button>
        ))}
      </div>
      <p className="font-mono text-[9.5px] text-muted-foreground">⏎ allow once · esc dismiss</p>
    </div>
  );
}
