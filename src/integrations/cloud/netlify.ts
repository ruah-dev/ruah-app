// src/integrations/cloud/netlify.ts — Netlify via the `netlify` CLI and its
// own login; teams (accounts) filter the site list. Read-only calls through
// `netlify api <operation>` (JSON on stdout): getCurrentUser,
// listAccountsForUser, listSites and, per site, listSiteDeploys with
// per_page 1 for the newest deploy. A site's health combines its published
// deploy with the newest one (CONTRACTS.md §9).
import { tmpdir } from "node:os";
import type { CloudHealth, CloudResource } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, str, type Json } from "../exec.js";
import { CliCloudAdapter, cloudResource, guarded, isoTime, type CheckResult, type CliAccount } from "./cli-adapter.js";

const PROVIDER = "netlify";
const SITE_ID_RE = /^[a-f0-9-]{8,64}$/i;
const MAX_SITES = 50;

/** Deploy states on the way to "ready". */
const BUILDING = new Set(["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed", "retrying"]);

export function netlifySiteHealth(published: Json | undefined, latest: Json | undefined): { health: CloudHealth; detail?: string } {
  const live = str(published?.state) === "ready" || str(published?.id) !== undefined;
  const state = str(latest?.state)?.toLowerCase();
  if (state !== undefined && BUILDING.has(state)) return { health: "deploying", detail: live ? `${state} · published deploy still live` : state };
  if (state === "error") {
    const reason = str(latest?.error_message);
    return live
      ? { health: "degraded", detail: `latest deploy failed${reason !== undefined ? ` (${reason.slice(0, 120)})` : ""} · published deploy still live` }
      : { health: "down", detail: `deploy failed${reason !== undefined ? ` (${reason.slice(0, 120)})` : ""}` };
  }
  if (live) return { health: "healthy" };
  return { health: "down", detail: "nothing published" };
}

export function mapSite(site: Json, latest: Json | undefined): CloudResource | undefined {
  const id = str(site.id) ?? str(site.site_id);
  const name = str(site.name);
  if (id === undefined || name === undefined) return undefined;
  const published = obj(site.published_deploy);
  const h = netlifySiteHealth(published, latest);
  const team = str(site.account_slug);
  const custom = str(site.custom_domain);
  return cloudResource(PROVIDER, {
    id: `netlify:site:${id}`, type: "app", service: "site", name,
    status: str(latest?.state)?.toLowerCase() ?? str(published?.state)?.toLowerCase(),
    tags: team !== undefined ? { team } : undefined,
    consoleUrl: str(site.admin_url) ?? `https://app.netlify.com/sites/${name}`,
    url: str(site.ssl_url) ?? str(site.url),
    hosts: [...(custom !== undefined ? [custom] : []), ...arr(site.domain_aliases).map(str).filter((d): d is string => d !== undefined)],
    createdAt: isoTime(site.created_at), health: h.health, healthDetail: h.detail,
  });
}

export class NetlifyIntegration extends CliCloudAdapter {
  readonly id = PROVIDER;
  readonly name = "Netlify";
  protected readonly binName = "netlify";
  protected readonly setupHint = "brew install netlify-cli && netlify login";
  protected readonly accountPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  protected readonly accountNoun = "team";
  // A linked .netlify/ in the daemon's cwd must not matter; stdin closed so nothing can prompt.
  protected override runOptions = { input: "", cwd: tmpdir(), env: { NETLIFY_TELEMETRY_DISABLED: "1" } };

  private api(bin: string, operation: string, data?: Record<string, unknown>): Promise<unknown> {
    return this.json(bin, ["api", operation, ...(data !== undefined ? ["--data", JSON.stringify(data)] : [])]);
  }

  protected async accounts(bin: string): Promise<CliAccount[]> {
    return arr(await this.api(bin, "listAccountsForUser")).flatMap((raw) => {
      const a = obj(raw);
      const slug = str(a?.slug);
      if (slug === undefined) return [];
      return [{ id: slug, label: str(a?.name) ?? slug }];
    });
  }

  protected async check(bin: string, account: string | undefined): Promise<CheckResult> {
    try {
      const user = obj(await this.api(bin, "getCurrentUser"));
      // The e-mail is never shown; the slug / name identifies the login.
      const who = str(user?.slug) ?? str(user?.full_name) ?? "?";
      return { ok: true, detail: `netlify: ${who}${account !== undefined ? ` · team ${account}` : ""}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "netlify failed";
      const loggedOut = /not logged in|log ?in|unauthori[sz]ed|401|access token/i.test(message);
      return { ok: false, status: loggedOut ? "not_connected" : "error", detail: message, setupHint: loggedOut ? "netlify login" : this.setupHint };
    }
  }

  protected async list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]> {
    const sites = arr(await this.api(bin, "listSites", { filter: "all" }))
      .map(obj)
      .filter((s): s is Json => s !== undefined && (account === undefined || str(s.account_slug) === account))
      .slice(0, MAX_SITES);
    const mapped = await mapLimit(sites, 4, async (site) => {
      const id = str(site.id);
      const latest = id !== undefined && SITE_ID_RE.test(id)
        ? (await guarded(`deploys ${str(site.name) ?? id}`, errors, async () => arr(await this.api(bin, "listSiteDeploys", { site_id: id, per_page: 1 })).map(obj)))[0]
        : undefined;
      return mapSite(site, latest);
    });
    return mapped.filter((r): r is CloudResource => r !== undefined);
  }
}
