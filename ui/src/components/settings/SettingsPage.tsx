// Settings: agent, model and permission mode (live on the daemon: agent.set / model.set /
// mode.set), appearance, onboarding, about. Layout in the flat Cursor settings idiom: labelled
// rows separated by hairlines, the control on the right.
import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { CLIENT_ID, setAgent, setAgentMode, setModel } from "@/lib/daemon";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { useTheme, type ThemePref } from "@/lib/theme";
import { AgentMark, modeLabel, plain } from "@/components/agent/ComposerControls";
import { PageHeader } from "@/components/shell/AppShell";
import { Segmented } from "@/components/map/MapPage";
import { cn } from "@/lib/utils";

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[14px] font-medium text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="divide-y divide-hairline border-y border-hairline">{children}</div>
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

export function SettingsPage() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const [theme, setTheme] = useTheme();
  const [health, setHealth] = useState<{ version?: string; agent?: unknown } | null>(null);
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const running = daemon.turns.some((t) => !t.stopReason);
  const agents = daemon.agent?.agents;
  const models = daemon.agent?.models;
  const modes = daemon.agent?.modes;

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
        ? "No daemon connected. Start archmap serve <repo> to choose an agent."
        : "Waiting for the daemon…"}
    </p>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-8 max-md:px-4">
          <Group
            title="Agent"
            description="Applies to the daemon's session right away; switching agents starts a new session."
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
                  mark={<AgentMark name={a.name} className="size-5 text-[9px]" />}
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

          {connected && (models?.available.length || daemon.agentSwitch) ? (
            <Group title="Model">
              {daemon.agentSwitch ? (
                <p className="py-3 text-[12.5px] text-muted-foreground">Starting {daemon.agentSwitch.name}…</p>
              ) : (
                models!.available.map((m) => (
                  <Choice
                    key={m.id}
                    active={m.id === models!.currentModelId}
                    disabled={running}
                    onClick={() => m.id !== models!.currentModelId && setModel(m.id)}
                    title={m.name}
                    description={m.description}
                  />
                ))
              )}
            </Group>
          ) : null}

          {connected && modes?.available.length ? (
            <Group title="Permission mode" description="How the agent asks before it changes files.">
              {modes.available.map((m) => (
                <Choice
                  key={m.id}
                  active={m.id === modes.currentModeId}
                  disabled={running}
                  onClick={() => m.id !== modes.currentModeId && setAgentMode(m.id)}
                  title={modeLabel(m)}
                  description={m.description}
                />
              ))}
            </Group>
          ) : null}

          <Group
            title="Integrations"
            description="Cloud providers, issue trackers and ruah orchestration."
          >
            <Row label="Connected services" hint="DigitalOcean, AWS, Jira, GitHub, ruah">
              <Link
                to="/integrations"
                className="flex h-7 items-center rounded-md bg-foreground/[0.06] px-2.5 text-[12.5px] text-foreground hover:bg-foreground/10"
              >
                Manage
              </Link>
            </Row>
          </Group>

          <Group title="Appearance">
            <Row label="Theme">
              <Segmented
                value={theme}
                onChange={(v: ThemePref) => setTheme(v)}
                options={[
                  { value: "system", label: "System" },
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Row>
          </Group>

          <Group title="Help">
            <Row label="Getting started" hint="Show the introduction again.">
              <button
                type="button"
                onClick={wb.resetOnboarding}
                className="h-7 rounded-md bg-foreground/[0.06] px-2.5 text-[12.5px] text-foreground hover:bg-foreground/10"
              >
                Show guide
              </button>
            </Row>
          </Group>

          <Group title="About">
            <Row label="Viewer">
              <span className="font-mono text-[12px] text-muted-foreground">{CLIENT_ID.replace("architects-canvas", "ruah")}</span>
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
