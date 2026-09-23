// Visual patterns adapted from t3code apps/web/src/components/chat/ProviderModelPicker.tsx,
// ComposerControl.tsx and CompactComposerControlsMenu.tsx (MIT): quiet ghost controls inside
// the composer's bottom row, one combined agent + model dropdown grouped by agent.
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Hand,
  ListChecks,
  Loader2,
  PencilLine,
  ShieldOff,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { AgentChoiceState, ModeState, ModelState } from "@/lib/contracts";
import type { AgentSwitch } from "@/lib/daemon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const controlClass =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50";

const itemClass =
  "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-[13px] focus:bg-accent data-[disabled]:opacity-45";

/** Small monochrome mark for a coding agent: its initials, no brand artwork. */
export function AgentMark({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground/10 text-[8px] leading-none font-semibold tracking-tight text-foreground/80",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** Descriptions come from the daemon with markdown code ticks; show them as plain text. */
export const plain = (s: string | undefined) => (s ?? "").replace(/`/g, "");

function OptionText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-foreground">{name}</span>
      {description ? (
        <span className="block text-[11.5px] leading-snug text-muted-foreground">
          {description}
        </span>
      ) : null}
    </span>
  );
}

/** Agent + model picker. Renders nothing when the daemon offers neither choice. */
export function AgentModelPicker({
  agents,
  models,
  switching,
  disabled,
  onModel,
  onAgent,
}: {
  agents: AgentChoiceState | undefined;
  models: ModelState | undefined;
  switching: AgentSwitch | null;
  disabled: boolean;
  onModel: (modelId: string) => void;
  onAgent: (agentId: string) => void;
}) {
  const hasModels = !!models?.available.length;
  const hasAgents = !!agents?.available.length;
  if (!hasModels && !hasAgents && !switching) return null;

  const currentAgent = agents?.available.find((a) => a.id === agents.currentAgentId);
  const currentModel = models?.available.find((m) => m.id === models.currentModelId);

  if (switching) {
    return (
      <span className={cn(controlClass, "pointer-events-none")}>
        <Loader2 className="size-3.5 animate-spin" />
        <span className="truncate">Starting {switching.name}…</span>
      </span>
    );
  }

  const modelItems = (models?.available ?? []).map((m) => {
    const active = m.id === models?.currentModelId;
    return (
      <DropdownMenuItem
        key={m.id}
        className={itemClass}
        onSelect={() => !active && onModel(m.id)}
      >
        <OptionText name={m.name} description={m.description} />
        <Check className={cn("mt-0.5 size-3.5 shrink-0 text-primary", !active && "invisible")} />
      </DropdownMenuItem>
    );
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(controlClass, "max-w-[15rem]")}
        aria-label="Choose agent and model"
      >
        {currentAgent ? <AgentMark name={currentAgent.name} /> : null}
        <span className="truncate">
          {currentAgent && currentModel
            ? `${currentAgent.name} · ${currentModel.name}`
            : (currentModel?.name ?? currentAgent?.name ?? "Model")}
        </span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] p-1"
      >
        {hasAgents ? (
          <>
            {currentAgent ? (
              <>
                <DropdownMenuLabel className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-[12px] font-medium text-muted-foreground">
                  <AgentMark name={currentAgent.name} />
                  {currentAgent.name}
                </DropdownMenuLabel>
                {modelItems.length ? (
                  modelItems
                ) : (
                  <p className="px-2 pb-1.5 text-[12px] text-muted-foreground">
                    Uses its default model.
                  </p>
                )}
              </>
            ) : null}
            {agents!.available.some((a) => a.id !== agents!.currentAgentId) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[12px] font-medium text-muted-foreground">
                  Switch agent
                </DropdownMenuLabel>
                {agents!.available
                  .filter((a) => a.id !== agents!.currentAgentId)
                  .map((a) => (
                    <DropdownMenuItem
                      key={a.id}
                      className={cn(itemClass, "items-center")}
                      disabled={!a.installed}
                      onSelect={() => onAgent(a.id)}
                      title={plain(a.installed ? a.description : a.installHint)}
                    >
                      <AgentMark name={a.name} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{a.name}</span>
                      {a.installed ? null : (
                        <span className="max-w-[55%] shrink-0 truncate text-[11.5px] text-muted-foreground">
                          {plain(a.installHint) || "Not installed"}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
              </>
            ) : null}
          </>
        ) : (
          <>
            <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[12px] font-medium text-muted-foreground">
              Model
            </DropdownMenuLabel>
            {modelItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const modeMeta: Record<string, { label: string; icon: LucideIcon }> = {
  default: { label: "Ask before edits", icon: Hand },
  acceptEdits: { label: "Accept edits", icon: PencilLine },
  plan: { label: "Plan", icon: ListChecks },
  bypassPermissions: { label: "Bypass permissions", icon: ShieldOff },
  auto: { label: "Auto", icon: Sparkles },
};

export function modeLabel(mode: { id: string; name: string }) {
  return modeMeta[mode.id]?.label ?? mode.name;
}

/** Permission mode (ACP session modes; sends mode.set). Hidden when the agent offers none. */
export function ModePicker({
  modes,
  disabled,
  onMode,
}: {
  modes: ModeState | undefined;
  disabled: boolean;
  onMode: (modeId: string) => void;
}) {
  if (!modes?.available.length) return null;
  const current = modes.available.find((m) => m.id === modes.currentModeId);
  const Icon = (current && modeMeta[current.id]?.icon) || Hand;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(controlClass, "max-w-[11rem]")}
        aria-label="Agent permission mode"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{current ? modeLabel(current) : "Mode"}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-72 p-1">
        {modes.available.map((m) => {
          const active = m.id === modes.currentModeId;
          const MIcon = modeMeta[m.id]?.icon ?? Hand;
          return (
            <DropdownMenuItem
              key={m.id}
              className={itemClass}
              onSelect={() => !active && onMode(m.id)}
            >
              <MIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <OptionText name={modeLabel(m)} description={m.description} />
              <Check className={cn("mt-0.5 size-3.5 shrink-0 text-primary", !active && "invisible")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
