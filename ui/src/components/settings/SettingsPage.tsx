// Settings: the current agent (live: agent.set), each agent's saved defaults — default agent,
// model and permission mode (daemon settings.json via defaults.set, CONTRACTS §5.7) —
// appearance (theme + palette with live previews: AppearanceSettings), onboarding, about.
// Layout in the flat Cursor settings idiom: labelled rows separated by hairlines, the control
// on the right.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { CLIENT_ID, setAgent, setDefaults, type DaemonState } from "@/lib/daemon";
import type { AgentChoiceState } from "@/lib/contracts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { AppearanceSettings } from "./AppearanceSettings";
import { PhantomAgent } from "@/components/brand/PhantomPose";
import { AgentMark, WarmDot, modeLabel, plain } from "@/components/agent/ComposerControls";
import { PageHeader } from "@/components/shell/AppShell";
import { FeaturesSettings } from "./FeaturesSettings";
import { LayoutSettingsRows } from "@/components/shell/LayoutSettings";
import { BUILD_ID } from "@/lib/build-reload";
import { cn } from "@/lib/utils";

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="heading text-title text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="card-warm divide-y divide-hairline px-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-6 py-2.5 max-sm:flex-col max-sm:items-start max-sm:gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  title,
  description,
  mark,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  description?: string | undefined;
  mark?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        !disabled && "hover:bg-accent/50",
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{title}</span>
        {description ? <span className="block text-[12px] text-muted-foreground">{description}</span> : null}
      </span>
      <Check className={cn("size-4 shrink-0 text-primary", !active && "invisible")} />
    </button>
  );
}

/** Radix Select items need a non-empty value: this one stands for "no saved choice". */
const AGENT_DEFAULT = "__agent_default__";

function DefaultSelect({
  label,
  value,
  options,
  fallback,
  onChange,
  disabled,
}: {
  label: string;
  value: string | undefined;
  options: { id: string; name: string }[];
  /** Shown for "no saved choice". */
  fallback: string;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const known = value === undefined || options.some((o) => o.id === value);
  return (
    <Select
      value={value ?? AGENT_DEFAULT}
      disabled={disabled === true}
      onValueChange={(v) => onChange(v === AGENT_DEFAULT ? null : v)}
    >
      <SelectTrigger
        aria-label={label}
        className="h-7 w-44 gap-1.5 border-hairline bg-transparent px-2 text-[12.5px] max-sm:w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AGENT_DEFAULT} className="text-[12.5px] text-muted-foreground">
          {fallback}
        </SelectItem>
        {!known && value ? (
          <SelectItem value={value} className="text-[12.5px]">
            {value}
          </SelectItem>
        ) : null}
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="text-[12.5px]">
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Settings → Agents: default agent, and the model and permission mode each agent starts with. */
function AgentDefaultsGroup({ daemon, agents }: { daemon: DaemonState; agents: AgentChoiceState }) {
  const defaults = daemon.agent?.defaults;
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = (key: string, patch: Parameters<typeof setDefaults>[0]) => {
    if (!setDefaults(patch)) return;
    setSaved(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(null), 2200);
  };
  const installed = agents.available.filter((a) => a.installed);
  const savedMark = (key: string) =>
    saved === key ? (
      <span className="flex items-center gap-1 text-[11.5px] text-ok" role="status">
        <Check className="size-3.5" /> Saved
      </span>
    ) : null;

  if (!defaults) {
    return (
      <p className="py-3 text-[12.5px] text-muted-foreground">
        This daemon does not keep saved defaults — update Ruah to choose them here.
      </p>
    );
  }
  return (
    <>
      <Row label="Default agent" hint="Started when Ruah opens. Switching agents in the composer updates it.">
        {savedMark("agent")}
        <DefaultSelect
          label="Default agent"
          value={defaults.agentId}
          options={installed.map((a) => ({ id: a.id, name: a.name }))}
          fallback="Claude Code"
          onChange={(v) => v && save("agent", { agentId: v })}
        />
      </Row>
      {installed.map((a) => {
        const isCurrent = a.id === agents.currentAgentId;
        const models = (isCurrent ? daemon.agent?.models : undefined) ?? a.models ?? daemon.modelsByAgent[a.id];
        const modes = (isCurrent ? daemon.agent?.modes : undefined) ?? a.modes ?? daemon.modesByAgent[a.id];
        const modeOptions = (modes?.available ?? []).map((m) => ({ id: m.id, name: modeLabel(m) }));
        const unknown = !models?.available.length && !modeOptions.length;
        return (
          <div key={a.id} className="flex flex-col gap-2 py-3">
            <div className="flex items-center gap-2">
              <AgentMark name={a.name} className="size-5 text-[9px]" />
              <span className="text-[13px] text-foreground">{a.name}</span>
              {isCurrent ? (
                <span className="rounded-pill bg-ai/15 px-1.5 text-[10px] font-medium text-ai">current</span>
              ) : (
                <WarmDot warm={a.warm} error={a.warmError} />
              )}
              <span className="ms-auto">{savedMark(a.id)}</span>
            </div>
            {unknown ? (
              <p className="text-[12px] text-muted-foreground">
                Its models and modes show up here once it has run (open the agent picker to start it).
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 ps-7">
                {models?.available.length ? (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    Model
                    <DefaultSelect
                      label={`${a.name} default model`}
                      value={defaults.models[a.id]}
                      options={models.available}
                      fallback="Agent's default"
                      onChange={(v) => save(a.id, { models: { [a.id]: v } })}
                    />
                  </label>
                ) : null}
                {modeOptions.length ? (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    Permissions
                    <DefaultSelect
                      label={`${a.name} default permission mode`}
                      value={defaults.modes[a.id]}
                      options={modeOptions}
                      fallback="Agent's default"
                      onChange={(v) => save(a.id, { modes: { [a.id]: v } })}
                    />
                  </label>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function SettingsPage() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const [health, setHealth] = useState<{ version?: string; agent?: unknown } | null>(null);
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const running = daemon.turns.some((t) => !t.stopReason);
  const agents = daemon.agent?.agents;

  useEffect(() => {
    if (!daemon.httpOrigin || daemon.source !== "daemon") return;
    void fetch(`${daemon.httpOrigin}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => setHealth(h as typeof health))
      .catch(() => setHealth(null));
  }, [daemon.httpOrigin, daemon.source]);

  const offline = (
    <p className="py-3 text-[12.5px] text-muted-foreground">
      {daemon.source === "sample"
        ? "No daemon connected. Start ruah app serve <repo> to choose an agent."
        : "Waiting for the daemon…"}
    </p>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-8 max-md:px-4">
          <Group
            title="Current agent"
            description="Applies right away. Agents you have used stay warm, so switching back is instant."
          >
            {!connected ? (
              offline
            ) : agents?.available.length ? (
              agents.available.map((a) => (
                <Choice
                  key={a.id}
                  active={a.id === agents.currentAgentId}
                  disabled={!a.installed || running || !!daemon.agentSwitch}
                  onClick={() => a.id !== agents.currentAgentId && setAgent(a.id)}
                  title={a.name}
                  description={plain(a.installed ? a.description : (a.installHint ?? "Not installed"))}
                  mark={
                    <PhantomAgent
                      agent={a.id}
                      size={32}
                      still
                      noFloat
                      tone={a.installed ? undefined : "muted"}
                    />
                  }
                />
              ))
            ) : (
              <Row label="Agent" hint="This daemon runs a single agent.">
                <span className="text-[13px] text-muted-foreground">
                  {daemon.agent?.agent ? `${daemon.agent.agent.name} ${daemon.agent.agent.version}` : "—"}
                </span>
              </Row>
            )}
          </Group>

          {connected && agents?.available.length ? (
            <Group
              title="Agents"
              description="What each agent starts with, saved on this Mac. By default agents edit files without asking; shell commands still ask. Picking a model or mode in the composer saves it here too."
            >
              <AgentDefaultsGroup daemon={daemon} agents={agents} />
            </Group>
          ) : null}

          <FeaturesSettings />

          <Group
            title="Integrations"
            description="Cloud providers, issue trackers and ruah orchestration."
          >
            <Row label="Connected services" hint="DigitalOcean, AWS, Jira, GitHub, ruah">
              <Link
                to="/integrations"
                className="flex h-7 items-center rounded-lg border border-hairline bg-surface-2 px-2.5 text-[12.5px] text-foreground hover:bg-surface-3"
              >
                Manage
              </Link>
            </Row>
          </Group>

          <Group title="Appearance" description="The Ruah design system: warm surfaces and six colour roles — Teal + Indigo by default.">
            <AppearanceSettings />
            <LayoutSettingsRows Row={Row} />
          </Group>

          <Group title="Help">
            <Row label="Getting started" hint="Show the introduction again.">
              <button
                type="button"
                onClick={wb.resetOnboarding}
                className="h-7 rounded-lg border border-hairline bg-surface-2 px-2.5 text-[12.5px] text-foreground hover:bg-surface-3"
              >
                Show guide
              </button>
            </Row>
          </Group>

          <Group title="About">
            <Row label="Viewer">
              <span className="font-mono text-[12px] text-muted-foreground">
                {CLIENT_ID.replace("architects-canvas", "ruah")}
                {BUILD_ID ? ` · build ${BUILD_ID}` : ""}
              </span>
            </Row>
            <Row label="Daemon">
              <span className="font-mono text-[12px] text-muted-foreground">
                {daemon.source !== "daemon" ? "not connected" : (health?.version ?? daemon.daemonVersion ?? "—")}
              </span>
            </Row>
            <Row label="Agent">
              <span className="font-mono text-[12px] text-muted-foreground">
                {daemon.agent?.agent ? `${daemon.agent.agent.name} ${daemon.agent.agent.version}` : "—"}
              </span>
            </Row>
            <Row label="Repository">
              <span className="max-w-80 truncate font-mono text-[12px] text-muted-foreground" title={daemon.root ?? undefined}>
                {daemon.root ?? "—"}
              </span>
            </Row>
            <Row label="Endpoint">
              <span className="max-w-80 truncate font-mono text-[12px] text-muted-foreground">
                {daemon.wsUrl ?? "—"}
              </span>
            </Row>
          </Group>
        </div>
      </div>
    </div>
  );
}
