// Integrations: one list per family (Cloud · Work · Orchestration) in the flat settings idiom.
// Each row shows the provider, its status and detail, an account picker (AWS profile, doctl
// context, Jira site) and Connect / Disconnect. CLI-based providers show the exact command to
// run when they are not connected; Ruah never runs a login for the user.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import type { IntegrationInfo } from "@/lib/contracts";
import {
  connectIntegration,
  disconnectIntegration,
  loadIntegrations,
  useLoad,
} from "@/lib/integrations";
import { PageHeader } from "@/components/shell/AppShell";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CopyCommand,
  PROVIDER_SETUP_LABEL,
  Pill,
  ProviderMark,
  RemoteNotice,
  SetupCommands,
  integrationGhost,
  integrationStatus,
  providerSetupState,
  setupCommands,
  quietButton,
  solidButton,
} from "./common";
import { JiraConnectDialog } from "./JiraConnectDialog";
import { Phantom } from "@/components/brand/Phantom";
import { cn } from "@/lib/utils";

const FAMILIES: { id: IntegrationInfo["family"]; title: string; description: string }[] = [
  {
    id: "cloud",
    title: "Cloud",
    description: "See what is deployed and link it to elements. Uses the provider CLI's own login, read-only.",
  },
  {
    id: "work",
    title: "Work items",
    description: "Link issues to elements and create them from an element's Details.",
  },
  {
    id: "orchestration",
    title: "Orchestration",
    description: "Run agent tasks in isolated worktrees with the ruah CLI.",
  },
];

/** Shown while the daemon has not answered, so the page has its final shape right away. */
const PLACEHOLDER: IntegrationInfo[] = [
  { id: "digitalocean", family: "cloud", name: "DigitalOcean", status: "not_connected" },
  { id: "aws", family: "cloud", name: "AWS", status: "not_connected" },
  { id: "vercel", family: "cloud", name: "Vercel", status: "not_connected" },
  { id: "supabase", family: "cloud", name: "Supabase", status: "not_connected" },
  { id: "kubernetes", family: "cloud", name: "Kubernetes", status: "not_connected" },
  { id: "netlify", family: "cloud", name: "Netlify", status: "not_connected" },
  { id: "hetzner", family: "cloud", name: "Hetzner Cloud", status: "not_connected" },
  { id: "gcp", family: "cloud", name: "Google Cloud", status: "not_connected" },
  { id: "azure", family: "cloud", name: "Azure", status: "not_connected" },
  { id: "cloudflare", family: "cloud", name: "Cloudflare", status: "not_connected" },
  { id: "railway", family: "cloud", name: "Railway", status: "not_connected" },
  { id: "fly", family: "cloud", name: "Fly.io", status: "not_connected" },
  { id: "jira", family: "work", name: "Jira", status: "not_connected" },
  { id: "github", family: "work", name: "GitHub", status: "not_connected" },
  { id: "ruah", family: "orchestration", name: "ruah", status: "not_connected" },
];

const ACCOUNT_NOUN: Record<string, string> = {
  aws: "Profile",
  digitalocean: "Context",
  vercel: "Team",
  supabase: "Organization",
  kubernetes: "Context",
  netlify: "Team",
  hetzner: "Context",
  jira: "Site",
  github: "Account",
  gcp: "Project",
  azure: "Subscription",
  cloudflare: "Account",
  railway: "Workspace",
  fly: "Org",
};

function currentAccount(info: IntegrationInfo): string | undefined {
  const accounts = info.accounts ?? [];
  const detail = info.detail ?? "";
  return (
    accounts.find((a) => detail.includes(a.id) || detail.includes(a.label))?.id ?? accounts[0]?.id
  );
}

function IntegrationRow({ info, placeholder }: { info: IntegrationInfo; placeholder: boolean }) {
  const [busy, setBusy] = useState<null | "connect" | "disconnect">(null);
  const [error, setError] = useState<string | null>(null);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [account, setAccount] = useState<string | undefined>(() => currentAccount(info));
  // §10 providers report install + login commands, so their pill can say which one is missing.
  const hasSetup = !!info.installCommand || !!info.loginCommand;
  const st = hasSetup ? PROVIDER_SETUP_LABEL[providerSetupState(info)] : integrationStatus(info.status);
  const connected = info.status === "connected";
  const isJira = info.id === "jira";
  const isRuah = info.id === "ruah";
  const accounts = info.accounts ?? [];

  const run = async (kind: "connect" | "disconnect", acc = account) => {
    setBusy(kind);
    setError(null);
    const res =
      kind === "connect"
        ? await connectIntegration(info.id, acc ? { account: acc } : {})
        : await disconnectIntegration(info.id);
    setBusy(null);
    if (!res.ok) setError(res.message);
    else if (kind === "connect" && res.data.status !== "connected")
      setError(res.data.detail ?? "Still not connected — run the command below, then try again.");
  };

  const showCommand =
    !placeholder && !connected && !!info.setupHint && !isJira && info.status !== "error" && !hasSetup;
  const showSetup = !placeholder && hasSetup && setupCommands(info).length > 0;

  return (
    <div className="py-3.5">
      <div className="flex items-center gap-3 max-sm:flex-wrap">
        <ProviderMark id={info.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13.5px] font-medium text-foreground">{info.name}</p>
            {placeholder ? null : (
          <Pill tone={st.tone} icon={integrationGhost(info.status)}>
            {st.label}
          </Pill>
        )}
          </div>
          <p
            className={cn(
              "truncate text-[12.5px]",
              info.status === "error" ? "text-bad/90" : "text-muted-foreground",
            )}
            title={info.detail}
          >
            {placeholder ? "Checking…" : (info.detail ?? (connected ? "Ready" : "Not set up"))}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!placeholder && accounts.length > 0 && !isRuah ? (
            <Select
              value={account ?? ""}
              onValueChange={(v) => {
                setAccount(v);
                // Switching profile/context on a connected provider re-selects it right away.
                if (connected && !isJira) void run("connect", v);
              }}
            >
              <SelectTrigger
                aria-label={`${info.name} ${ACCOUNT_NOUN[info.id] ?? "account"}`}
                className="h-7 w-auto min-w-32 gap-1.5 border-hairline bg-transparent px-2 text-[12.5px]"
              >
                <span className="text-muted-foreground">{ACCOUNT_NOUN[info.id] ?? "Account"}</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="text-[12.5px]">
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {placeholder ? null : isRuah ? (
            connected ? (
              <Link to="/tasks" className={quietButton}>
                Open tasks <ArrowUpRight className="size-3.5" />
              </Link>
            ) : (
              <button type="button" className={solidButton} onClick={() => void loadIntegrations()}>
                Check again
              </button>
            )
          ) : connected ? (
            <button
              type="button"
              className={quietButton}
              disabled={busy !== null}
              onClick={() => void run("disconnect")}
            >
              {busy === "disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Disconnect
            </button>
          ) : info.status === "cli_missing" ? (
            <button type="button" className={solidButton} onClick={() => void loadIntegrations()}>
              Check again
            </button>
          ) : isJira ? (
            <button type="button" className={solidButton} onClick={() => setJiraOpen(true)}>
              Connect…
            </button>
          ) : (
            <button
              type="button"
              className={solidButton}
              disabled={busy !== null}
              onClick={() => void run("connect")}
            >
              {busy === "connect" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {info.status === "error" ? "Retry" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {showCommand ? (
        <div className="mt-2.5 ms-11 space-y-1.5">
          <p className="text-[12px] text-muted-foreground">
            {info.status === "cli_missing"
              ? "Install the CLI, then check again:"
              : isRuah
                ? "Initialise ruah in this repository:"
                : "Log in with the provider's CLI in a terminal, then connect:"}
          </p>
          <CopyCommand command={info.setupHint!} runnable className="max-w-md" />
        </div>
      ) : null}
      {showSetup ? (
        <div className="mt-2.5 ms-11 space-y-1.5">
          <p className="text-[12px] text-muted-foreground">
            {info.status === "cli_missing"
              ? "Install the CLI and log in, then check again:"
              : "Log in with the provider's CLI, then check again:"}
          </p>
          <SetupCommands info={info} />
        </div>
      ) : null}
      {error ?<p className="mt-2 ms-11 text-[12.5px] text-bad">{error}</p> : null}

      {isJira ? (
        <JiraConnectDialog
          open={jiraOpen}
          onOpenChange={setJiraOpen}
          defaultSite={accounts[0]?.label ?? ""}
        />
      ) : null}
    </div>
  );
}

export function IntegrationsPage() {
  const s = useLoad("integrations");
  const remote = s.integrations;
  const list = remote.status === "ok" ? remote.data : null;
  const placeholder = list === null;
  const items = list ?? PLACEHOLDER;
  const connectedCount = list?.filter((i) => i.status === "connected").length ?? 0;

  const grouped = useMemo(
    () =>
      FAMILIES.map((f) => ({ ...f, items: items.filter((i) => i.family === f.id) })).filter(
        (f) => f.items.length > 0,
      ),
    [items],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Integrations">
        {list ? (
          <span className="text-[12px] text-muted-foreground">
            {connectedCount} of {list.length} connected
          </span>
        ) : null}
        <button
          type="button"
          className={quietButton}
          onClick={() => void loadIntegrations()}
          disabled={remote.status === "loading"}
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-3.5", remote.status === "loading" && "animate-spin")} />
          Refresh
        </button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-8 max-md:px-4">
          <div className="space-y-2">
            <p className="eyebrow">Connected services</p>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Connect your cloud, issue tracker and ruah so the map shows what runs where and who is
              working on it. Credentials stay with the provider CLIs or in your Keychain.
            </p>
          </div>
          <RemoteNotice remote={remote} what="Integrations" />
          {list && list.length > 0 && connectedCount === 0 ? (
            <div className="flex items-center gap-4 rounded-xl border border-hairline bg-surface-1 px-4 py-3.5">
              <Phantom expression="idle" size="md" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-[13px] font-medium text-foreground">Nothing connected yet</p>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  Pick a service below. Each one tells you the single command it needs.
                </p>
              </div>
            </div>
          ) : null}
          {grouped.map((f) => (
            <section key={f.id} className="flex flex-col gap-3">
              <div>
                <h2 className="heading text-title text-foreground">{f.title}</h2>
                <p className="mt-1 text-[12.5px] text-muted-foreground">{f.description}</p>
              </div>
              <div
                className={cn(
                  "card-warm divide-y divide-hairline px-4",
                  placeholder && remote.status !== "loading" && "opacity-60",
                )}
              >
                {f.items.map((i) => (
                  <IntegrationRow
                    key={`${i.id}-${placeholder ? "p" : "l"}`}
                    info={i}
                    placeholder={placeholder}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
