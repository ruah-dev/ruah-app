// Small shared pieces of the Extensions page: kind marks, pills, the per-agent switches, the
// "What it runs" block and the secret rows. Flat idiom (hairlines, muted text, one accent):
// teal only for interactive controls, lavender for agent things, slate / amber for metadata.
import { useState, type ReactNode } from "react";
import { Check, KeyRound, Loader2, Plug, Puzzle, ScrollText, Sparkles, Terminal, Globe, Zap, type LucideIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AGENT_LABEL,
  EXTENSION_AGENTS,
  KIND_LABEL,
  agentSwitch,
  describeServer,
  type ExtensionAgent,
  type ExtensionKind,
  type ExtensionView,
  type ServerPreview,
  type WhatItRuns,
} from "@/lib/extensions";

export const quietButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
export const solidButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 text-ui-sm text-foreground transition-colors hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40";
export const primaryButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-ui-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40";
export const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-hairline bg-surface-0 px-2.5 text-ui text-foreground placeholder:text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const KIND_MARK: Record<ExtensionKind, { icon: LucideIcon; className: string }> = {
  skill: { icon: Sparkles, className: "bg-ai/15 text-ai" },
  mcp: { icon: Plug, className: "bg-info/15 text-info" },
  power: { icon: Zap, className: "bg-warn/15 text-warn" },
  plugin: { icon: Puzzle, className: "bg-surface-3 text-foreground/85" },
  rule: { icon: ScrollText, className: "bg-surface-3 text-muted-foreground" },
};

export function KindMark({ kind, className }: { kind: ExtensionKind; className?: string }) {
  const mark = KIND_MARK[kind];
  const Icon = mark.icon;
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-lg", mark.className, className)}>
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}

export function Chip({ children, tone = "muted", title }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "bad" | "ai" | "info"; title?: string | undefined }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta whitespace-nowrap",
        tone === "muted" && "bg-foreground/[0.06] text-muted-foreground",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "warn" && "bg-warn/12 text-warn",
        tone === "bad" && "bg-bad/12 text-bad",
        tone === "ai" && "bg-ai/12 text-ai",
        tone === "info" && "bg-info/12 text-info",
      )}
    >
      {children}
    </span>
  );
}

export function KindChip({ kind }: { kind: ExtensionKind }) {
  return <Chip>{KIND_LABEL[kind]}</Chip>;
}

export function ScopeChip({ scope }: { scope: "global" | "project" }) {
  return <Chip tone={scope === "project" ? "info" : "muted"}>{scope === "project" ? "This project" : "Global"}</Chip>;
}

export function StatusChip({ view }: { view: ExtensionView }) {
  if (view.status === "ready") {
    return view.enabledFor.length > 0 ? <Chip tone="ok">On for {view.enabledFor.length}</Chip> : <Chip>Off</Chip>;
  }
  const label = view.status === "review" ? "Needs review" : view.status === "missing" ? "Not on this machine" : "Invalid";
  return (
    <Chip tone={view.status === "review" ? "warn" : "bad"} title={view.statusDetail}>
      {label}
    </Chip>
  );
}

/** A compact segmented control (the page's own, so it does not depend on the shell's). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex h-7 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-hairline", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-ui-sm transition-colors max-sm:px-2",
            value === o.value ? "bg-surface-4 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One switch per agent. `busy` is the agent being toggled. */
export function AgentSwitches({
  view,
  installed,
  busy,
  onToggle,
}: {
  view: ExtensionView;
  installed: Partial<Record<ExtensionAgent, boolean>>;
  busy: ExtensionAgent | null;
  onToggle: (agent: ExtensionAgent, on: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Agents that use ${view.name}`}>
      {EXTENSION_AGENTS.map((agent) => {
        const s = agentSwitch(view, agent);
        const missing = installed[agent] === false;
        return (
          <Tooltip key={agent}>
            <TooltipTrigger asChild>
              <label
                className={cn(
                  "flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-ui-sm transition-colors",
                  s.on ? "border-ai/30 bg-ai/[0.07] text-foreground" : "border-hairline bg-surface-1 text-muted-foreground",
                  s.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {busy === agent ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Switch
                    checked={s.on}
                    disabled={s.disabled || busy !== null}
                    onCheckedChange={(on) => onToggle(agent, on)}
                    aria-label={`${s.on ? "Disable" : "Enable"} ${view.name} for ${AGENT_LABEL[agent]}`}
                    className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
                  />
                )}
                <span className={cn(missing && "line-through decoration-faint")}>{AGENT_LABEL[agent]}</span>
                {s.hint !== null ? <span className="text-meta text-faint">{s.hint}</span> : null}
              </label>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-label">
              {missing ? `${AGENT_LABEL[agent]} is not installed. ` : ""}
              {s.note}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ServerLine({ server }: { server: ServerPreview }) {
  const Icon = server.transport === "stdio" ? Terminal : Globe;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-label text-foreground/90 [overflow-wrap:anywhere]">{describeServer(server)}</p>
        {server.env.length > 0 || (server.headers ?? []).length > 0 ? (
          <p className="mt-0.5 font-mono text-meta text-muted-foreground">
            {server.env.length > 0 ? `env ${server.env.join(", ")}` : ""}
            {server.env.length > 0 && (server.headers ?? []).length > 0 ? " · " : ""}
            {(server.headers ?? []).length > 0 ? `headers ${(server.headers ?? []).join(", ")}` : ""}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-meta text-faint">{server.name}</span>
    </div>
  );
}

/** Exactly what an extension will run: commands + args or URLs, env var names, hooks, files. */
export function WhatItRunsBlock({ what, className }: { what: WhatItRuns; className?: string }) {
  const nothing = what.servers.length === 0 && what.hooks.length === 0;
  return (
    <div className={cn("space-y-2 rounded-lg bg-surface-0 px-3 py-2.5 ring-1 ring-hairline", className)}>
      {nothing ? <p className="text-label text-muted-foreground">Runs nothing — instructions only.</p> : null}
      {what.servers.map((s) => (
        <ServerLine key={s.name} server={s} />
      ))}
      {what.hooks.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-meta text-faint">Hooks and other commands (run by agents that load the plugin)</p>
          {what.hooks.map((h, i) => (
            <p key={`${i}:${h}`} className="font-mono text-label text-foreground/90 [overflow-wrap:anywhere]">
              {h}
            </p>
          ))}
        </div>
      ) : null}
      {what.files.length > 0 ? (
        <p className="truncate text-meta text-muted-foreground" title={what.files.join("\n")}>
          Files: {what.files.slice(0, 6).join(", ")}
          {what.files.length > 6 ? ` +${what.files.length - 6}` : ""}
        </p>
      ) : null}
      {what.launcher ? (
        <p className="text-meta text-muted-foreground">Starts through Ruah's launcher, which reads the secrets from the Keychain when the server starts.</p>
      ) : null}
    </div>
  );
}

/** Secret row: name, where the value comes from, and a one-shot password field to save it. */
export function SecretRow({
  name,
  set,
  fromEnv,
  onSave,
  onDelete,
}: {
  name: string;
  set: boolean;
  fromEnv: boolean;
  onSave: (value: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    const err = await onSave(value);
    setBusy(false);
    if (err !== null) setError(err);
    else {
      setValue("");
      setEditing(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <KeyRound className="size-3.5 shrink-0 text-faint" />
      <span className="font-mono text-label text-foreground/90">{name}</span>
      {set ? (
        <Chip tone="ok">
          <Check className="size-3" /> In Keychain
        </Chip>
      ) : fromEnv ? (
        <Chip tone="info">From environment</Chip>
      ) : (
        <Chip tone="warn">Not set</Chip>
      )}
      <span className="flex-1" />
      {editing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setValue(next);
            }}
            placeholder="Value (stored in the Keychain)"
            aria-label={`Value for ${name}`}
            className={cn(fieldClass, "h-7 w-56")}
          />
          <button type="submit" className={primaryButton} disabled={busy || value.length === 0}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </button>
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              setValue("");
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button type="button" className={quietButton} onClick={() => setEditing(true)}>
            {set ? "Replace" : "Set…"}
          </button>
          {set ? (
            <button
              type="button"
              className={quietButton}
              onClick={() => {
                void onDelete().then((err) => setError(err));
              }}
            >
              Delete
            </button>
          ) : null}
        </>
      )}
      {error !== null ? <p className="basis-full text-label text-bad">{error}</p> : null}
    </div>
  );
}
