// Visual patterns adapted from t3code apps/web/src/components/chat/ProviderModelPicker.tsx,
// ComposerControl.tsx and CompactComposerControlsMenu.tsx (MIT): quiet ghost controls inside
// the composer's bottom row, one combined agent + model dropdown grouped by agent.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import type { AgentChoiceState, AgentDefaults, ModeState, ModelState, WarmState } from "@/lib/contracts";
import type { AgentSwitch } from "@/lib/daemon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Phantom, type PhantomExpression } from "@/components/brand/Phantom";
import { PhantomAgent, agentTintFromName } from "@/components/brand/PhantomPose";

const controlClass =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-ui-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50";

const cmdItemClass =
  "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-ui data-[selected=true]:bg-ai/12 data-[disabled=true]:opacity-45";

const itemClass =
  "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-ui focus:bg-accent data-[disabled]:opacity-45";

/** Small mark for a coding agent: its initials, no brand artwork. Known agents wear their
 * identity tint (design tokens --agent-*: the same colour as their ghost and their chart
 * series) as the fill and ring; the letters stay in the foreground colour so they read. */
export function AgentMark({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  const tint = agentTintFromName(name);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] text-[8px] leading-none font-semibold tracking-tight",
        tint
          ? "bg-[color-mix(in_oklab,var(--mark)_24%,transparent)] text-foreground ring-1 ring-[color-mix(in_oklab,var(--mark)_60%,transparent)]"
          : "bg-ai/18 text-ai ring-1 ring-ai/25",
        className,
      )}
      style={tint ? ({ "--mark": `var(--agent-${tint})` } as CSSProperties) : undefined}
    >
      {initials}
    </span>
  );
}

/** Pre-warm state of an agent as a tiny ghost: sage = ready (switching is instant), amber
 * loading = starting, muted = cold (only with `showCold`; otherwise nothing when cold). */
export function WarmDot({
  warm,
  error,
  showCold = false,
  size = 12,
}: {
  warm: WarmState | undefined;
  error?: string | undefined;
  showCold?: boolean;
  size?: number;
}) {
  if (warm !== "ready" && warm !== "starting" && !showCold) return null;
  const label =
    warm === "ready"
      ? "Ready — switching is instant"
      : warm === "starting"
        ? "Starting in the background…"
        : error
          ? "Didn't start"
          : "Not running — starts when you pick it";
  return (
    <span title={error ?? label} className="inline-flex shrink-0">
      <Phantom
        expression={warm === "starting" ? "loading" : "idle"}
        tone={warm === "ready" ? "sage" : warm === "starting" ? undefined : "muted"}
        still={warm !== "starting"}
        size={size}
        label={label}
      />
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
        <span className="block text-meta leading-snug text-muted-foreground">
          {description}
        </span>
      ) : null}
    </span>
  );
}

/** Agent + model picker (⌘. opens it; type to filter, ↑↓, Enter). Every installed agent is
 * listed with the models last seen for it, so switching agent and model is one step; the
 * model of an agent that is not running yet is applied once it has started ("warming…").
 * Renders nothing when the daemon offers neither choice. */
export function AgentModelPicker({
  agents,
  models,
  modelsByAgent = {},
  defaults,
  switching,
  disabled,
  open: openProp,
  onOpenChange,
  onModel,
  onAgent,
  onAgentModel,
  onPrewarm,
  expression = "agent",
}: {
  /** The current agent's face (useAgentExpression). */
  expression?: PhantomExpression;
  agents: AgentChoiceState | undefined;
  models: ModelState | undefined;
  modelsByAgent?: Record<string, ModelState>;
  /** Saved defaults: the default model of each agent gets a small "default" tag. */
  defaults?: AgentDefaults | undefined;
  switching: AgentSwitch | null;
  disabled: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onModel: (modelId: string) => void;
  onAgent: (agentId: string) => void;
  /** Switch to another agent and pick one of its models in one step. */
  onAgentModel?: (agentId: string, modelId: string) => void;
  /** Start agents in the background (all when no ids): on open, and for the row under the pointer. */
  onPrewarm?: (agentIds?: string[]) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  // Opening the picker starts the other agents, so the one the user picks is ready by the click.
  const prewarmRef = useRef(onPrewarm);
  prewarmRef.current = onPrewarm;
  useEffect(() => {
    if (open) prewarmRef.current?.();
  }, [open]);
  const hasModels = !!models?.available.length;
  const hasAgents = !!agents?.available.length;
  if (!hasModels && !hasAgents && !switching) return null;

  const currentAgent = agents?.available.find((a) => a.id === agents.currentAgentId);
  const currentModel = models?.available.find((m) => m.id === models.currentModelId);

  if (switching) {
    return (
      <span
        className={cn(controlClass, "pointer-events-none")}
        role="status"
        aria-label={`Warming ${switching.name}`}
      >
        <Phantom expression="loading" size="xs" />
        <span className="truncate">Warming {switching.name}…</span>
      </span>
    );
  }

  const installed = (agents?.available ?? []).filter((a) => a.installed);
  const ordered = [
    ...installed.filter((a) => a.id === agents?.currentAgentId),
    ...installed.filter((a) => a.id !== agents?.currentAgentId),
  ];
  const missing = (agents?.available ?? []).filter((a) => !a.installed);

  const choose = (agentId: string | null, modelId: string | null) => {
    setOpen(false);
    if (!agentId || agentId === agents?.currentAgentId) {
      if (modelId && modelId !== models?.currentModelId) onModel(modelId);
      return;
    }
    if (modelId && onAgentModel) onAgentModel(agentId, modelId);
    else onAgent(agentId);
  };

  const defaultTag = (
    <span className="ms-1.5 rounded-pill bg-foreground/[0.07] px-1.5 align-[1px] text-micro font-medium text-muted-foreground">
      default
    </span>
  );
  const modelItem = (agentId: string | null, agentName: string, m: { id: string; name: string; description?: string }, active: boolean) => {
    const isDefault = !!defaults && defaults.models[agentId ?? agents?.currentAgentId ?? ""] === m.id;
    return (
      <CommandItem
        key={`${agentId ?? "-"}:${m.id}`}
        value={`${agentName} ${m.name} ${m.id}`.trim()}
        onSelect={() => choose(agentId, m.id)}
        className={cmdItemClass}
      >
        <OptionText
          name={
            <>
              {m.name}
              {isDefault ? defaultTag : null}
            </>
          }
          description={plain(m.description)}
        />
        <Check className={cn("mt-0.5 size-3.5 shrink-0 text-ai", !active && "invisible")} />
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(controlClass, "max-w-[15rem]")}
        aria-label="Choose agent and model"
        title="Agent and model (⌘.)"
      >
        <PhantomAgent agent={agents?.currentAgentId ?? ""} expression={expression} size="xs" />
        <span className="truncate">
          {currentAgent && currentModel
            ? `${currentAgent.name} · ${currentModel.name}`
            : (currentModel?.name ?? currentAgent?.name ?? "Model")}
        </span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border-hairline p-0 shadow-elevated"
      >
        <Command
          className="bg-transparent"
          loop
          {...(currentModel
            ? { defaultValue: `${currentAgent?.name ?? ""} ${currentModel.name} ${currentModel.id}`.trim() }
            : {})}
        >
          <CommandInput autoFocus placeholder="Switch agent or model…" className="h-10 text-ui" />
          <CommandList className="max-h-[min(55vh,380px)] p-1">
            <CommandEmpty className="py-5 text-center text-ui-sm text-muted-foreground">
              No agent or model matches.
            </CommandEmpty>
            {hasAgents ? (
              ordered.map((a) => {
                const isCurrent = a.id === agents!.currentAgentId;
                const list = isCurrent ? models : (a.models ?? modelsByAgent[a.id]);
                return (
                  <CommandGroup
                    key={a.id}
                    onPointerEnter={isCurrent ? undefined : () => onPrewarm?.([a.id])}
                    heading={
                      <span className="flex items-center gap-2">
                        {isCurrent ? (
                          <PhantomAgent agent={a.id} expression={expression} size="xs" />
                        ) : (
                          <WarmDot warm={a.warm} error={a.warmError} showCold size={16} />
                        )}
                        {a.name}
                        {isCurrent ? (
                          <span className="rounded-pill pill-ai px-1.5 text-micro font-medium">current</span>
                        ) : null}
                        {!isCurrent && a.warm === "cold" && a.warmError ? (
                          <span className="min-w-0 truncate text-micro font-normal text-faint" title={a.warmError}>
                            didn't start
                          </span>
                        ) : null}
                      </span>
                    }
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {list?.available.length ? (
                      list.available.map((m) =>
                        modelItem(a.id, a.name, m, isCurrent && m.id === models?.currentModelId),
                      )
                    ) : (
                      <CommandItem
                        value={`${a.name} default model`}
                        onSelect={() => choose(a.id, null)}
                        className={cmdItemClass}
                        title={plain(a.description)}
                      >
                        <OptionText
                          name={isCurrent ? "Default model" : `Use ${a.name}`}
                          description={isCurrent ? "This agent picks its model." : plain(a.description) || "Starts a new session"}
                        />
                        <Check className={cn("mt-0.5 size-3.5 shrink-0 text-ai", !isCurrent && "invisible")} />
                      </CommandItem>
                    )}
                  </CommandGroup>
                );
              })
            ) : (
              <CommandGroup heading="Model" className="[&_[cmdk-group-heading]]:section-label">
                {(models?.available ?? []).map((m) =>
                  modelItem(null, "", m, m.id === models?.currentModelId),
                )}
              </CommandGroup>
            )}
            {missing.length ? (
              <CommandGroup heading="Not installed" className="[&_[cmdk-group-heading]]:section-label">
                {missing.map((a) => (
                  <CommandItem key={a.id} value={`${a.name} not installed`} disabled className={cn(cmdItemClass, "items-center")}>
                    <AgentMark name={a.name} />
                    <span className="min-w-0 flex-1 truncate text-foreground">{a.name}</span>
                    <span className="max-w-[55%] shrink-0 truncate text-meta text-muted-foreground" title={plain(a.installHint)}>
                      {plain(a.installHint) || "Not installed"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-1.5 text-meta text-muted-foreground">
            <kbd className="kbd">⌘.</kbd> opens this
            <span className="ms-auto flex items-center gap-1">
              <kbd className="kbd">↵</kbd> select
            </span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
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
              <Check className={cn("mt-0.5 size-3.5 shrink-0 text-ai", !active && "invisible")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
