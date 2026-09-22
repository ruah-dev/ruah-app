import { Bot, Code2, Copy, CornerDownRight, Pin } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { kindStyles } from "./kinds";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";

type Props = {
  node: DiagramNode;
  onDrill: () => void;
  onOpenCode: () => void;
  onAsk: () => void;
  onCopy: () => void;
  onPin: () => void;
};

const actionClass = "h-7 w-full justify-start rounded-[4px] px-2 text-[11px] font-normal shadow-none";

export function NodePopoverContent({ node, onDrill, onOpenCode, onAsk, onCopy, onPin }: Props) {
  const style = kindStyles[node.kind];
  const Icon = style.icon;

  return (
    <div className="w-56">
      <div className="flex items-start gap-2 px-1 pb-2">
        <Icon className={`mt-0.5 size-4 shrink-0 ${style.color}`} />
        <div className="min-w-0">
          <p className="truncate font-mono text-[12.5px] font-medium">{node.label}</p>
          <Badge variant="outline" className="mt-1 h-4 rounded-sm px-1 text-[9.5px] uppercase">
            {style.label}
          </Badge>
        </div>
      </div>
      <Separator className="bg-hairline" />
      <div className="pt-1.5">
        <Button type="button" variant="ghost" className={actionClass} onClick={onDrill} disabled={!node.drill}>
          <CornerDownRight className="size-3.5 text-muted-foreground" />
          Drill in
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {node.drill ? "⏎" : "n/a"}
          </span>
        </Button>
        <Button type="button" variant="ghost" className={actionClass} onClick={onOpenCode}>
          <Code2 className="size-3.5 text-muted-foreground" />
          Open code
        </Button>
        <Button type="button" variant="ghost" className={actionClass} onClick={onAsk}>
          <Bot className="size-3.5 text-primary" />
          Ask agent
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">⌘K</span>
        </Button>
        <Separator className="my-1.5 bg-hairline" />
        <Button type="button" variant="ghost" className={actionClass} onClick={onCopy}>
          <Copy className="size-3.5 text-muted-foreground" />
          Copy path
        </Button>
        <Button type="button" variant="ghost" className={actionClass} onClick={onPin}>
          <Pin className="size-3.5 text-muted-foreground" />
          Pin to sidebar
        </Button>
      </div>
    </div>
  );
}
