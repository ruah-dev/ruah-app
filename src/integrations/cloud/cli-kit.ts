// src/integrations/cloud/cli-kit.ts — shared base for the CLI-backed cloud
// providers of batch B (Google Cloud, Azure, Cloudflare, Railway, Fly.io;
// CONTRACTS.md §10). Each adapter is a standalone library module: it needs
// only an injectable Runner and a SettingsStore, never the daemon, a
// SessionHub or an open project. The base owns the parts every provider
// shares: CLI resolution, "not installed" / "not logged in" states with the
// exact Homebrew install and login commands, account selection, disconnect,
// and staying quiet when the CLI is unusable (enabled() is false, so a
// "sync all" never spawns it and never reports it as an error).
import type { CloudResource, CloudResourceType, ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { arr, cliMessage, CliError, IntegrationError, obj, parseJson, resolveBin, str, type Json, type Runner, type RunOptions } from "../exec.js";
import type { CloudIntegration, CloudSyncOutcome, ProjectContext } from "../registry.js";
import type { SettingsStore } from "../store.js";

/**
 * Live-health vocabulary shared by every batch-B adapter's pure `healthOf()`.
 * Not wired into CloudResource yet (the live-status work owns that field);
 * exported so it can be mapped 1:1 once it lands.
 */
export type HealthState = "healthy" | "degraded" | "down" | "deploying" | "unknown";

export interface CliCloudDeps {
  runner: Runner;
  settings: SettingsStore;
  /** Absolute CLI path; default: first of `spec.bins` on PATH (+ Homebrew dirs). */
  bin?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface CliSpec {
  id: string;
  name: string;
  /** Executable names tried in order ("flyctl", "fly"). */
  bins: readonly string[];
  /** Exact Homebrew install command. */
  install: string;
  /** Exact login command. */
  login: string;
  /** What an account is called in messages ("project", "subscription", …). */
  accountNoun: string;
  /** Account ids accepted from the viewer (they end up as CLI arguments). */
  accountRe: RegExp;
  /** CLI failure text that means "credentials missing or expired". */
  authError: RegExp;
}

export type Session =
  | { loggedIn: false; reason: string }
  | {
      loggedIn: true;
      /** "me@example.com", shown in the detail line. */
      who?: string | undefined;
      accounts: { id: string; label: string }[];
      /** The CLI's own default account, used when Ruah has no selection. */
      current?: string | undefined;
      /** Logged in but not usable yet (e.g. gcloud without a project). */
      problem?: { detail: string; hint: string } | undefined;
    };

export interface CollectContext {
  bin: string;
  account: string | undefined;
  session: Extract<Session, { loggedIn: true }>;
  project: ProjectContext | null;
  errors: string[];
}

/** Builds a CloudResource without undefined optional fields (exactOptionalPropertyTypes). */
export function cloudResource(
  provider: string,
  fields: {
    id: string;
    type: CloudResourceType;
    service: string;
    name: string | undefined;
    region?: string | undefined;
    status?: string | undefined;
    url?: string | undefined;
    tags?: Record<string, string> | undefined;
    consoleUrl?: string | undefined;
  },
): CloudResource {
  const out: CloudResource = { id: fields.id, provider, type: fields.type, service: fields.service, name: fields.name ?? fields.id };
  if (fields.region !== undefined) out.region = fields.region;
  if (fields.status !== undefined) out.status = fields.status;
  if (fields.url !== undefined) out.url = fields.url;
  if (fields.tags !== undefined && Object.keys(fields.tags).length > 0) out.tags = fields.tags;
  if (fields.consoleUrl !== undefined) out.consoleUrl = fields.consoleUrl;
  return out;
}

/** Objects of an array (non-objects dropped). */
export function objects(value: unknown): Json[] {
  return arr(value).map(obj).filter((v): v is Json => v !== undefined);
}

/** GraphQL connection `{ edges: [{ node }] }` or a plain array → nodes. */
export function nodes(value: unknown): Json[] {
  if (Array.isArray(value)) return objects(value);
  return objects(obj(value)?.edges).map((e) => obj(e.node)).filter((v): v is Json => v !== undefined);
}

/** First present key, for CLIs whose JSON casing varies by version ("Name" / "name"). */
export function pick(o: Json | undefined, ...keys: string[]): unknown {
  if (o === undefined) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** {k: v} string labels → tags, skipping provider-internal keys. */
export function labelTags(value: unknown, skip: (key: string) => boolean = () => false): Record<string, string> | undefined {
  const record = obj(value);
  if (record === undefined) return undefined;
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (skip(k)) continue;
    if (typeof v === "string") tags[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") tags[k] = String(v);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/** "RUNNABLE" / "Running" / "pending_create" → "runnable" / "running" / "pending create". */
export function lowerState(value: unknown): string | undefined {
  const s = str(value);
  return s === undefined ? undefined : s.replace(/_/g, " ").toLowerCase();
}

/** The part of a composite status before " · " ("running · 3 nodes" → "running"), normalised. */
export function nativeState(state: string | undefined | null): string {
  return (state ?? "").split(" · ")[0]!.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * JSON from a CLI that may print a banner or warnings before it (wrangler
 * prints "⛅️ wrangler 3.x" + a rule line): the whole text, else from the first
 * line that starts a JSON value.
 */
export function looseJson(text: string): unknown {
  const direct = parseJson(text);
  if (direct !== undefined) return direct;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trimStart();
    if (t.startsWith("[") || t.startsWith("{")) {
      const parsed = parseJson(lines.slice(i).join("\n"));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

/**
 * Box-drawn or pipe tables (cli-table3 as used by wrangler) → rows keyed by
 * the header cells. Rule lines (┌─┬─┐, ├─, +--+) are skipped.
 */
export function parseTextTable(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!/^[│|]/.test(line)) continue;
    const cells = line.replace(/^[│|]|[│|]$/g, "").split(/[│|]/).map((c) => c.trim());
    if (cells.every((c) => /^[-─═+]*$/.test(c))) continue;
    rows.push(cells);
  }
  const [header, ...body] = rows;
  if (header === undefined) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

/**
 * A provider backed by one CLI. Subclasses supply the session probe (cheap:
 * who is logged in + accounts) and the read-only listings.
 */
export abstract class CliCloudIntegration implements CloudIntegration {
  readonly family = "cloud" as const;
  readonly id: string;
  readonly name: string;
  /** Last login state observed; "out" makes enabled() false until info() sees a login. */
  private loginState: "unknown" | "in" | "out" = "unknown";

  constructor(
    protected readonly spec: CliSpec,
    protected readonly deps: CliCloudDeps,
  ) {
    this.id = spec.id;
    this.name = spec.name;
  }

  /** Who is logged in and which accounts exist. May throw CliError / IntegrationError. */
  protected abstract session(bin: string): Promise<Session>;
  /** The read-only listings; per-service failures go to ctx.errors. */
  protected abstract collect(ctx: CollectContext): Promise<CloudResource[]>;
  /** Connected detail line. */
  protected describe(session: Extract<Session, { loggedIn: true }>, account: string | undefined): string {
    const label = session.accounts.find((a) => a.id === account)?.label ?? account;
    return [session.who, label !== undefined ? `${this.spec.accountNoun} ${label}` : undefined].filter(Boolean).join(" · ") || "logged in";
  }
  /** Extra CLI environment for an account (Cloudflare selects accounts by env var). */
  protected accountEnv(_account: string | undefined): Record<string, string> | undefined {
    return undefined;
  }

  protected bin(): string | undefined {
    if (this.deps.bin !== undefined) return this.deps.bin();
    for (const name of this.spec.bins) {
      const found = resolveBin(name, this.deps.env ?? process.env);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  protected env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Runs the CLI; rejects with IntegrationError(502, redacted message) on a non-zero exit. */
  protected async run(bin: string, args: string[], options: RunOptions & { account?: string | undefined } = {}): Promise<string> {
    const { account, ...rest } = options;
    const env = { ...this.accountEnv(account), ...rest.env };
    const result = await this.deps.runner(bin, args, Object.keys(env).length > 0 ? { ...rest, env } : rest);
    if (result.code !== 0) throw new IntegrationError(502, cliMessage(result));
    return result.stdout;
  }

  /** Runs the CLI and parses JSON (banner-tolerant); empty output is `fallback`. */
  protected async runJson(bin: string, args: string[], options: RunOptions & { account?: string | undefined } = {}, fallback: unknown = []): Promise<unknown> {
    const stdout = await this.run(bin, args, options);
    if (stdout.trim().length === 0) return fallback;
    const parsed = looseJson(stdout);
    if (parsed === undefined) throw new IntegrationError(502, `unexpected (non-JSON) ${this.spec.bins[0]} output`);
    return parsed;
  }

  protected commands(): Pick<IntegrationInfo, "installCommand" | "loginCommand"> {
    return { installCommand: this.spec.install, loginCommand: this.spec.login };
  }

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...this.commands(), ...extra };
  }

  protected checkAccount(account: string | undefined): string | undefined {
    if (account !== undefined && !this.spec.accountRe.test(account)) throw new IntegrationError(400, `invalid ${this.name} ${this.spec.accountNoun}`);
    return account;
  }

  /** Installed, not disconnected in Ruah, and not known to be logged out. */
  enabled(): boolean {
    return this.deps.settings.get(this.id).disabled !== true && this.loginState !== "out" && this.bin() !== undefined;
  }

  async info(): Promise<IntegrationInfo> {
    const bin = this.bin();
    const cli = this.spec.bins[0]!;
    if (bin === undefined) {
      return this.base({ status: "cli_missing", detail: `${cli} is not installed`, setupHint: `${this.spec.install} && ${this.spec.login}` });
    }
    if (this.deps.settings.get(this.id).disabled === true) {
      // Quiet: no CLI call for a provider the user switched off.
      return this.base({ status: "not_connected", detail: `disconnected in Ruah (${cli} login unchanged)`, setupHint: `Connect to use your ${cli} login` });
    }
    let session: Session;
    try {
      session = await this.session(bin);
    } catch (err) {
      if (err instanceof CliError && err.kind === "missing") {
        return this.base({ status: "cli_missing", detail: `${cli} is not installed`, setupHint: `${this.spec.install} && ${this.spec.login}` });
      }
      const message = err instanceof Error ? err.message : `${cli} failed`;
      if (this.spec.authError.test(message)) session = { loggedIn: false, reason: message };
      else return this.base({ status: "error", detail: message, setupHint: this.spec.login });
    }
    if (!session.loggedIn) {
      this.loginState = "out";
      return this.base({ status: "not_connected", detail: `not logged in to ${cli}${session.reason ? ` — ${session.reason}` : ""}`, setupHint: this.spec.login });
    }
    this.loginState = "in";
    const account = this.deps.settings.get(this.id).account ?? session.current;
    if (session.problem !== undefined && this.deps.settings.get(this.id).account === undefined) {
      return this.base({ status: "not_connected", detail: session.problem.detail, setupHint: session.problem.hint, accounts: session.accounts });
    }
    return this.base({ status: "connected", detail: this.describe(session, account), accounts: session.accounts });
  }

  async connect(body: ConnectBody): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.info();
    const { disabled: _disabled, ...rest } = this.deps.settings.get(this.id);
    const next = { ...rest };
    if (body.account !== undefined) {
      this.checkAccount(body.account);
      const session = await this.session(bin).catch((): Session => ({ loggedIn: false, reason: "" }));
      if (session.loggedIn && session.accounts.length > 0 && !session.accounts.some((a) => a.id === body.account)) {
        throw new IntegrationError(400, `unknown ${this.name} ${this.spec.accountNoun} "${body.account}"`);
      }
      next.account = body.account;
    }
    this.deps.settings.set(this.id, next);
    this.loginState = "unknown";
    return this.info();
  }

  async disconnect(): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, { disabled: true });
    return this.info();
  }

  async sync(options: { account?: string; project?: ProjectContext | null }): Promise<CloudSyncOutcome> {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, `${this.spec.bins[0]} not installed — ${this.spec.install}`);
    const session = await this.session(bin).catch((err: unknown): Session => {
      const message = err instanceof Error ? err.message : "";
      if (err instanceof IntegrationError && this.spec.authError.test(message)) return { loggedIn: false, reason: message };
      throw err;
    });
    if (!session.loggedIn) {
      this.loginState = "out";
      throw new IntegrationError(401, `not logged in — run: ${this.spec.login}`);
    }
    this.loginState = "in";
    const account = this.checkAccount(options.account ?? this.deps.settings.get(this.id).account ?? session.current);
    if (account === undefined && session.problem !== undefined) throw new IntegrationError(409, `${session.problem.detail} — run: ${session.problem.hint}`);
    const errors: string[] = [];
    const resources = await this.collect({ bin, account, session, project: options.project ?? null, errors });
    // Every listing failing on credentials is one "log in again", not N errors.
    if (resources.length === 0 && errors.length > 0 && errors.every((e) => this.spec.authError.test(e))) {
      this.loginState = "out";
      throw new IntegrationError(401, `credentials expired or missing — run: ${this.spec.login}`);
    }
    return { resources, errors };
  }
}

/** A read-only listing: CLI args, a mapper, and failure text that means "none exist". */
export interface Listing<C> {
  service: string;
  args: string[];
  map: (json: unknown, ctx: C) => CloudResource[];
  empty?: RegExp;
}

/** Message of a caught error, for per-service error lines. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

