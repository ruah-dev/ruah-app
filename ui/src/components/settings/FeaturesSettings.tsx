// Settings → Features & behaviour: every optional feature has a switch (each also works on its own
// from the CLI). Daemon-side flags (§13.6 background agents / notifications, §11.8 the project's
// IaC scan option) go through the daemon; viewer-side ones are kept in this window
// (lib/preferences.ts).
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { NotificationMode } from "@/lib/contracts";
import { useActivity } from "@/lib/activity";
import { fetchScanOptions, setFeatureFlags, setScanOptions } from "@/lib/daemon";
import { setViewerPref, useViewerPrefs } from "@/lib/preferences";
import { useWorkspace } from "@/lib/workspace";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/map/MapPage";
import { setReadAppLogins } from "@/components/usage/agentLimitsStore";

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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ScanInfraSwitch() {
  const { daemon } = useWorkspace();
  const projectId = daemon.project?.id ?? null;
  const connected = daemon.source === "daemon" && daemon.connection === "open" && !!projectId;
  const [infra, setInfra] = useState<boolean | null>(null);
  useEffect(() => {
    if (!connected || !projectId) {
      setInfra(null);
      return;
    }
    let live = true;
    fetchScanOptions(projectId)
      .then((r) => live && setInfra(r.options.infra))
      .catch(() => live && setInfra(null));
    return () => {
      live = false;
    };
  }, [connected, projectId]);
  return (
    <Switch
      checked={infra ?? true}
      disabled={!connected || infra === null}
      aria-label="Infrastructure-as-code in scans"
      onCheckedChange={(on) => {
        const before = infra;
        setInfra(on);
        setScanOptions({ ...(projectId ? { id: projectId } : {}), infra: on })
          .then((r) => setInfra(r.options.infra))
          .catch((err: unknown) => {
            setInfra(before);
            toast.error("Couldn't change the scan option", { description: message(err) });
          });
      }}
    />
  );
}

/** §20.1: off by default; saved by the daemon, so every window (and the Cursor limits card) follows. */
function ReadAppLoginsSwitch({ enabled }: { enabled: boolean }) {
  const { daemon } = useWorkspace();
  const activity = useActivity();
  const usage = activity.settings.usage;
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (pending !== null && usage?.readAppLogins === pending) setPending(null);
  }, [pending, usage?.readAppLogins]);
  return (
    <Switch
      checked={pending ?? usage?.readAppLogins ?? false}
      disabled={!enabled || !usage || usage.source === "env" || pending !== null}
      aria-label="Read Cursor's saved login to show plan usage"
      onCheckedChange={(on) => {
        setPending(on);
        setReadAppLogins(on, daemon.httpOrigin).catch((err: unknown) => {
          setPending(null);
          toast.error("Couldn't change the setting", { description: message(err) });
        });
      }}
    />
  );
}

export function FeaturesSettings() {
  const { daemon } = useWorkspace();
  const activity = useActivity();
  const prefs = useViewerPrefs();
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const flags = activity.supported && connected;
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="heading text-title text-foreground">Features & behaviour</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Everything here is optional — turn off what you do not use. Each part also works on its own from the CLI
          (<code className="font-mono">ruah app resume</code>, <code className="font-mono">ruah app activity</code>,{" "}
          <code className="font-mono">ruah app scan --no-infra</code>, <code className="font-mono">ruah app cloud</code>,{" "}
          <code className="font-mono">ruah app usage settings</code>).
        </p>
      </div>
      <div className="card-warm divide-y divide-hairline px-4">
        <Row
          label="Background agents"
          hint={`A running agent keeps working when you switch projects (at most ${activity.maxBackgroundTurns || 3} at a time). Off: switching stops it.`}
        >
          <Switch
            checked={activity.settings.backgroundAgents}
            disabled={!flags}
            aria-label="Background agents"
            onCheckedChange={(on) => setFeatureFlags({ backgroundAgents: on })}
          />
        </Row>
        <Row label="Notifications" hint="When an agent finishes or asks for permission. Background: only for projects you are not looking at.">
          <Segmented
            value={activity.settings.notifications}
            onChange={(v: NotificationMode) => setFeatureFlags({ notifications: v })}
            options={[
              { value: "background", label: "Background", disabled: !flags },
              { value: "always", label: "Always", disabled: !flags },
              { value: "off", label: "Off", disabled: !flags },
            ]}
          />
        </Row>
        <Row
          label="Infrastructure-as-code in scans"
          hint={
            daemon.project
              ? `For ${daemon.project.name}: Terraform, Kubernetes, Helm, Ansible, Docker and CI on the map. Applies at the next rescan.`
              : "Per project; open a project to change it."
          }
        >
          <ScanInfraSwitch />
        </Row>
        <Row
          label="Read Cursor's saved login to show plan usage"
          hint={
            activity.settings.usage?.source === "env"
              ? `Set by RUAH_USAGE_READ_LOGINS=${activity.settings.usage.readAppLogins ? "1" : "0"}; unset it to choose here.`
              : activity.settings.usage
                ? "Cursor's included usage and on-demand spend come from cursor.com with the Cursor app's login. The token stays in memory and is never stored. Off: Cursor shows its tier only."
                : "Needs a newer Ruah daemon."
          }
        >
          <ReadAppLoginsSwitch enabled={flags} />
        </Row>
        <Row label="Live cloud status" hint="Refresh cloud health while the Cloud page is open. Off: only when you sync.">
          <Switch
            checked={prefs.cloudLive}
            aria-label="Live cloud status"
            onCheckedChange={(on) => setViewerPref("cloudLive", on)}
          />
        </Row>
        <Row label="“Where you left off”" hint="A card with what happened while you were away, when you switch into a project.">
          <Switch
            checked={prefs.resumeCard}
            aria-label="Where you left off card"
            onCheckedChange={(on) => setViewerPref("resumeCard", on)}
          />
        </Row>
        <Row
          label="Launcher from anywhere"
          hint={
            bridge?.setLauncherShortcut
              ? "⌥Space in any app brings Ruah to the front with the launcher open."
              : "Desktop app only: ⌥Space in any app opens the Ruah launcher."
          }
        >
          <Switch
            checked={prefs.globalShortcut}
            disabled={!bridge?.setLauncherShortcut}
            aria-label="Global launcher shortcut"
            onCheckedChange={(on) => {
              setViewerPref("globalShortcut", on);
              if (!on || !bridge?.setLauncherShortcut) return;
              void bridge.setLauncherShortcut(true).then((ok) => {
                if (!ok) {
                  setViewerPref("globalShortcut", false);
                  toast.error("⌥Space is taken", { description: "Another app already uses it as a global shortcut." });
                }
              });
            }}
          />
        </Row>
      </div>
    </section>
  );
}
