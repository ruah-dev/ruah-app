// Agent: the same conversation as the Map's side panel, as its own page with the column centered
// (Cursor agents window / Claude Code desktop).
import { useState } from "react";
import { kindFor } from "@/lib/architecture";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { PageHeader } from "@/components/shell/AppShell";
import { DrawerToggle, PageDrawer } from "@/components/shell/PageDrawer";
import { AgentSidebarSection } from "@/components/shell/SidebarSections";
import { kindStyles } from "@/components/explorer/kinds";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { AgentPanel, NewSessionButton } from "./AgentPanel";
import { ChatSwitcher } from "@/components/chats/ChatSwitcher";
import { ChatStrip } from "@/components/shell/ChatStrip";

export function AgentPage() {
  const { daemon, architecture } = useWorkspace();
  const wb = useWorkbench();
  const [picking, setPicking] = useState(false);
  const node = wb.selectedNode;
  const chat = daemon.chats.find((c) => c.id === daemon.activeChatId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        leading={<DrawerToggle label="Turns" />}
        title={
          daemon.projectsSupported && daemon.project ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground">Agent</span>
              <span className="text-faint">/</span>
              <ChatSwitcher className="-ms-1" />
            </span>
          ) : chat ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Agent</span>
              <span className="text-faint">/</span>
              <span className="truncate">{chat.title || "Untitled chat"}</span>
            </span>
          ) : daemon.projectsSupported && daemon.turns.length === 0 ? (
            "New chat"
          ) : (
            "Agent"
          )
        }
      >
        <NewSessionButton daemon={daemon} />
      </PageHeader>
      <ChatStrip className="px-3" />
      <div className="flex min-h-0 flex-1">
        {wb.outlineOpen ? (
          <PageDrawer title="In this chat">
            <AgentSidebarSection />
          </PageDrawer>
        ) : null}
        <AgentPanel
          node={node}
          contextPath={node ? wb.contextPathFor(node) : ""}
          daemon={daemon}
          architecture={architecture}
          onOpenPath={wb.openPath}
          onClearContext={wb.clearSelection}
          onPickContext={() => setPicking(true)}
          focusSignal={wb.askSignal}
          focusTurnId={wb.focusTurnId}
        />
      </div>
      <CommandDialog open={picking} onOpenChange={setPicking}>
        <CommandInput placeholder="Add an element as context…" className="text-[13.5px]" />
        <CommandList className="max-h-[min(60vh,420px)]">
          <CommandEmpty className="py-6 text-center text-[13px] text-muted-foreground">
            No element matches.
          </CommandEmpty>
          <CommandGroup heading="Elements">
            {architecture.nodes.map((n) => {
              const kind = kindStyles[kindFor(n.type)];
              const Icon = kind.icon;
              return (
                <CommandItem
                  key={n.id}
                  value={`${n.name} ${n.path ?? ""} ${n.id}`}
                  onSelect={() => {
                    wb.selectNode(n.id);
                    setPicking(false);
                  }}
                  className="gap-2.5 rounded-md text-[13px]"
                >
                  <Icon className={cn("size-4", kind.color)} />
                  <span className="truncate">{n.name}</span>
                  <span className="ms-auto truncate font-mono text-[11.5px] text-muted-foreground">
                    {n.path ?? n.type}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}
