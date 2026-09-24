// "Connect a provider": every cloud provider the daemon knows, with its onboarding state
// (connected / not logged in / not installed / disconnected) and the exact command that fixes
// it — copyable, and runnable in the integrated terminal when the app has one. Nothing here
// runs a login for the user; "Check again" just re-reads the providers' status.
import { useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import type { IntegrationInfo } from "@/lib/contracts";
import { connectIntegration, loadIntegrations } from "@/lib/integrations";
import {
  IntegrationsLink,
  PROVIDER_SETUP_LABEL,
  Pill,
  ProviderMark,
  SetupCommands,
  providerSetupState,
  quietButton,
  solidButton,
} from "@/components/integrations/common";
import { cn } from "@/lib/utils";

/** Ready first, then the ones one command away, then the ones that need an install. */
const ORDER = { connected: 0, not_logged_in: 1, error: 2, disconnected: 3, not_installed: 4 } as const;

function ProviderLine({ info }: { info: IntegrationInfo }) {
  const [busy, setBusy] = useState(false);
  const state = providerSetupState(info);
  const label = PROVIDER_SETUP_LABEL[state];
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <ProviderMark id={info.id} className="size-7" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium text-foreground">{info.name}</p>
            <Pill tone={label.tone}>{label.label}</Pill>
          </div>
          {info.detail && state !== "not_installed" ? (
            <p className={cn("truncate text-[12px]", state === "error" ? "text-bad/90" : "text-muted-foreground")} title={info.detail}>
              {info.detail}
            </p>
          ) : null}
        </div>
        {state === "disconnected" ? (
          <button
            type="button"
            className={solidButton}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void connectIntegration(info.id, {}).finally(() => setBusy(false));
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Connect
          </button>
        ) : null}
      </div>
      <SetupCommands info={info} className="mt-2 ms-10" />
    </li>
  );
}

export function ConnectProviders({
  providers,
  collapsible = false,
  className,
}: {
  /** Cloud-family integrations (any status). */
  providers: IntegrationInfo[];
  /** Start folded behind a one-line summary (used once something is connected). */
  collapsible?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [checking, setChecking] = useState(false);
  if (!providers.length) return null;
  const sorted = [...providers].sort(
    (a, b) => ORDER[providerSetupState(a)] - ORDER[providerSetupState(b)] || a.name.localeCompare(b.name),
  );
  const connected = providers.filter((p) => p.status === "connected").length;

  const check = () => {
    setChecking(true);
    void loadIntegrations().finally(() => setChecking(false));
  };

  return (
    <section className={cn("rounded-xl border border-hairline bg-surface-1 px-4", className)} aria-label="Cloud providers">
      <div className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {connected ? "Cloud providers" : "Connect a provider"}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {connected} of {providers.length} connected · Ruah uses each CLI's own login and only reads. Manage in{" "}
            <IntegrationsLink />.
          </p>
        </div>
        <button type="button" className={quietButton} onClick={check} disabled={checking} aria-label="Check again">
          <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
          Check again
        </button>
        {collapsible ? (
          <button
            type="button"
            className={quietButton}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? "Hide providers" : "Show providers"}
          >
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {open ? <ul className="divide-y divide-hairline border-t border-hairline">{sorted.map((p) => <ProviderLine key={p.id} info={p} />)}</ul> : null}
    </section>
  );
}
