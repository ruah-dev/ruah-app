import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, X } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Props = {
  node: DiagramNode;
  contextPath: string;
  screen: { x: number; y: number };
  onClose: () => void;
  onSubmit: (prompt: string) => void;
};

const suggestions = [
  "Explain this flow",
  "Where are the API requests handled?",
  "What breaks if this fails?",
];

export function AgentBubble({ node, contextPath, screen, onClose, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [node.id]);

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    onSubmit(prompt);
    setValue("");
    onClose();
  };

  return (
    <div
      className="absolute z-30 w-[340px] animate-in fade-in-0 duration-100"
      style={{ left: screen.x, top: screen.y }}
    >
      <div className="control-glass overflow-hidden rounded-md border border-hairline">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Ask agent
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="ml-auto size-6 text-muted-foreground hover:text-foreground"
            aria-label="Close agent prompt"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="px-3 pt-2.5">
          <Badge
            variant="outline"
            className="h-5 gap-1 rounded-[3px] border-primary/30 bg-primary/5 px-1.5 font-mono text-[10px] text-primary"
          >
            @{contextPath}
          </Badge>
        </div>
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(value);
            }
            if (e.key === "Escape") onClose();
          }}
          rows={3}
          placeholder={`Ask about ${node.label}…`}
          className="mt-2 resize-none border-0 bg-transparent px-3 font-mono text-[12px] shadow-none focus-visible:ring-0"
        />
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {suggestions.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => send(s)}
              className="h-6 rounded-[4px] border-hairline bg-surface-2 px-2 text-[10px] text-muted-foreground shadow-none hover:bg-surface-3 hover:text-foreground"
            >
              {s}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            ⏎ send · ⇧⏎ newline · esc close
          </span>
          <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={() => send(value)}>
            Send <ArrowUp className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
