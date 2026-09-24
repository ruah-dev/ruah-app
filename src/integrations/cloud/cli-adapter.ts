// src/integrations/cloud/cli-adapter.ts — the shared plumbing of the CLI-first
// cloud adapters added in CONTRACTS.md §9 (Vercel, Supabase, Kubernetes,
// Netlify, Hetzner): binary lookup, "not installed" / "disconnected in Ruah"
// states, account (team / org / context) selection validated against the
// CLI's own list, JSON runs that never interpolate a shell and never echo
// arguments. Subclasses supply accounts(), check() and list(). No daemon
// dependency: the CLI (`ruah app cloud`) and the daemon use the same classes.
import type { CloudHealth, CloudResource, CloudResourceType, ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { cliMessage, CliError, IntegrationError, parseJson, resolveBin, type RunOptions, type Runner } from "../exec.js";
import type { CloudIntegration, CloudSyncOutcome } from "../registry.js";
import type { SettingsStore } from "../store.js";

export interface CliAdapterDeps {
  runner: Runner;
  settings: SettingsStore;
  /** Absolute CLI path; default: resolved from PATH + Homebrew. Tests pass fakes. */
  bin?: () => string | undefined;
}

export interface CliAccount {
  id: string;
  label: string;
  current?: boolean;
}

export type CheckResult =
  | { ok: true; detail: string }
  | { ok: false; status: "not_connected" | "error"; detail: string; setupHint: string };

export interface ResourceFields {
  id: string;
  type: CloudResourceType;
  service: string;
  name: string | undefined;
  region?: string | undefined;
  status?: string | undefined;
  tags?: Record<string, string> | undefined;
  consoleUrl?: string | undefined;
  url?: string | undefined;
  hosts?: readonly string[] | undefined;
  createdAt?: string | undefined;
  health?: CloudHealth | undefined;
  healthDetail?: string | undefined;
  replicas?: { ready: number; desired: number } | undefined;
  pods?: { running: number; pending: number; crashLoop: number; restarts: number } | undefined;
}

/** A CloudResource with only the defined optional fields (exactOptionalPropertyTypes). */
export function cloudResource(provider: string, f: ResourceFields): CloudResource {
  const out: CloudResource = { id: f.id, provider, type: f.type, service: f.service, name: f.name ?? f.id };
  if (f.region !== undefined) out.region = f.region;
  if (f.status !== undefined) out.status = f.status;
  if (f.tags !== undefined && Object.keys(f.tags).length > 0) out.tags = f.tags;
  if (f.consoleUrl !== undefined) out.consoleUrl = f.consoleUrl;
  if (f.url !== undefined) out.url = f.url;
  if (f.hosts !== undefined && f.hosts.length > 0) out.hosts = [...new Set(f.hosts)];
  if (f.createdAt !== undefined) out.createdAt = f.createdAt;
  if (f.health !== undefined) out.health = f.health;
  if (f.healthDetail !== undefined && f.healthDetail.length > 0) out.healthDetail = f.healthDetail;
  if (f.replicas !== undefined) out.replicas = f.replicas;
  if (f.pods !== undefined) out.pods = f.pods;
  return out;
}

/** Epoch ms / seconds / ISO → ISO string (undefined when unparseable). */
export function isoTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isFinite(n) && n > 0) return new Date(/^\d+$/.test(value) && n < 1e12 ? n * 1000 : n).toISOString();
  }
  return undefined;
}

export abstract class CliCloudAdapter implements CloudIntegration {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly family = "cloud" as const;
  /** Executable name looked up on PATH. */
  protected abstract readonly binName: string;
  /** What the user runs to install and log in (shown when missing). */
  protected abstract readonly setupHint: string;
  /** Account ids (team slug, org, context) accepted before they reach an argv. */
  protected abstract readonly accountPattern: RegExp;
  /** "team", "organization", "context" — used in messages. */
  protected abstract readonly accountNoun: string;
  /** Extra run options (cwd, closed stdin, env) for every call. */
  protected runOptions: RunOptions = {};

  constructor(protected readonly deps: CliAdapterDeps) {}

  /** The CLI's accounts; the current one flagged. May throw when not logged in. */
  protected abstract accounts(bin: string): Promise<CliAccount[]>;
  /** Cheap authenticated call for info(). */
  protected abstract check(bin: string, account: string | undefined): Promise<CheckResult>;
  /** Everything the account can see; per-service failures go to `errors`. */
  protected abstract list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]>;

  protected bin(): string | undefined {
    return this.deps.bin !== undefined ? this.deps.bin() : resolveBin(this.binName);
  }

  enabled(): boolean {
    return this.deps.settings.get(this.id).disabled !== true;
  }

  protected base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  protected checkAccount(account: string | undefined): string | undefined {
    if (account !== undefined && (!this.accountPattern.test(account) || account.startsWith("-"))) {
      throw new IntegrationError(400, `invalid ${this.name} ${this.accountNoun} name`);
    }
    return account;
  }

  /** Runs the CLI; non-zero exit → IntegrationError(502) with the redacted first lines. */
  protected async run(bin: string, args: string[]): Promise<string> {
    const result = await this.deps.runner(bin, args, this.runOptions);
    if (result.code !== 0) throw new IntegrationError(502, cliMessage(result));
    return result.stdout;
  }

  /** run() + JSON.parse; empty output is `null`, non-JSON output an error. */
  protected async json(bin: string, args: string[]): Promise<unknown> {
    const stdout = await this.run(bin, args);
    if (stdout.trim().length === 0) return null;
    const parsed = parseJson(stdout);
    if (parsed === undefined) throw new IntegrationError(502, `unexpected (non-JSON) ${this.binName} output`);
    return parsed;
  }

  /** Stored selection, else the CLI's current account (undefined = the CLI's default). */
  protected async selectedAccount(bin: string): Promise<string | undefined> {
    const stored = this.deps.settings.get(this.id).account;
    if (stored !== undefined) return stored;
    try {
      return (await this.accounts(bin)).find((a) => a.current === true)?.id;
    } catch {
      return undefined;
    }
  }

  async info(): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.base({ status: "cli_missing", detail: `${this.binName} not installed`, setupHint: this.setupHint });
    let accounts: CliAccount[] = [];
    try {
      accounts = await this.accounts(bin);
    } catch {
      // not logged in / no config: check() explains
    }
    const listed = accounts.map((a) => ({ id: a.id, label: a.current === true ? `${a.label} (current)` : a.label }));
    const withAccounts = listed.length > 0 ? { accounts: listed } : {};
    if (this.deps.settings.get(this.id).disabled === true) {
      return this.base({
        status: "not_connected", detail: `disconnected in Ruah (${this.binName} login unchanged)`,
        setupHint: `Connect to use your ${this.binName} login`, ...withAccounts,
      });
    }
    const account = this.checkAccount(this.deps.settings.get(this.id).account ?? accounts.find((a) => a.current === true)?.id);
    try {
      const result = await this.check(bin, account);
      return result.ok
        ? this.base({ status: "connected", detail: result.detail, ...withAccounts })
        : this.base({ status: result.status, detail: result.detail, setupHint: result.setupHint, ...withAccounts });
    } catch (err) {
      return this.base({
        status: "error", detail: err instanceof CliError || err instanceof IntegrationError ? err.message : `${this.binName} failed`,
        setupHint: this.setupHint, ...withAccounts,
      });
    }
  }

  async connect(body: ConnectBody): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.info();
    const { disabled: _disabled, ...rest } = this.deps.settings.get(this.id);
    const next = { ...rest };
    if (body.account !== undefined) {
      this.checkAccount(body.account);
      let known: CliAccount[] = [];
      try {
        known = await this.accounts(bin);
      } catch (err) {
        throw new IntegrationError(424, `${this.name}: ${err instanceof Error ? err.message : "not logged in"}`);
      }
      if (!known.some((a) => a.id === body.account)) throw new IntegrationError(400, `unknown ${this.name} ${this.accountNoun} "${body.account}"`);
      next.account = body.account;
    }
    this.deps.settings.set(this.id, next);
    return this.info();
  }

  async disconnect(): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, { disabled: true });
    return this.info();
  }

  async sync(options: { account?: string }): Promise<CloudSyncOutcome> {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, `${this.binName} not installed — ${this.setupHint}`);
    const account = this.checkAccount(options.account ?? (await this.selectedAccount(bin)));
    const errors: string[] = [];
    const resources = await this.list(bin, account, errors);
    return { resources, errors };
  }
}

/** Runs one listing; failures become "<service>: <message>" in `errors` and an empty result. */
export async function guarded<T>(service: string, errors: string[], fn: () => Promise<T[]>, ignore?: RegExp): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if (ignore?.test(message) === true) return [];
    errors.push(`${service}: ${message}`);
    return [];
  }
}
