// src/integrations/cloud/hetzner.ts — Hetzner Cloud via the `hcloud` CLI and
// its contexts (one per project, token stored by hcloud); contexts are the
// accounts. Read-only: `context list` / `context active` (local), and
// `server list`, `load-balancer list`, `volume list` with `-o json`, passing
// `--context <name>`. Server IPs are never copied; a load balancer's public
// address is its entry point and is (CONTRACTS.md §9).
import type { CloudHealth, CloudResource } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, parseJson, str, type Json } from "../exec.js";
import { healthFrom, type HealthTable } from "../health.js";
import { CliCloudAdapter, cloudResource, guarded, isoTime, type CheckResult, type CliAccount } from "./cli-adapter.js";

const PROVIDER = "hetzner";
const CONSOLE = "https://console.hetzner.cloud/projects";

export const HETZNER_HEALTH = {
  server: {
    running: "healthy", initializing: "deploying", starting: "deploying", rebuilding: "deploying", migrating: "deploying",
    stopping: "down", off: "down", deleting: "down", unknown: "unknown",
  },
} satisfies Record<string, HealthTable>;

const labels = (value: unknown): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(value) ?? {})) if (typeof v === "string") out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
};

const each = (json: unknown): Json[] => arr(json).map(obj).filter((v): v is Json => v !== undefined);
const locationOf = (item: Json): string | undefined => str(obj(item.location)?.name) ?? str(obj(obj(item.datacenter)?.location)?.name);

export function mapServers(json: unknown): CloudResource[] {
  return each(json).flatMap((s) => {
    const id = str(s.id);
    if (id === undefined) return [];
    const status = str(s.status);
    const type = str(obj(s.server_type)?.name);
    return [cloudResource(PROVIDER, {
      id: `hcloud:server:${id}`, type: "compute", service: "server", name: str(s.name), region: locationOf(s), status,
      tags: labels(s.labels), consoleUrl: CONSOLE, createdAt: isoTime(s.created),
      health: healthFrom(status, HETZNER_HEALTH.server), healthDetail: type !== undefined ? type : undefined,
    })];
  });
}

/** Load balancer health from its targets' per-port health checks. */
export function loadBalancerHealth(lb: Json): { health: CloudHealth; detail: string } {
  const checks = arr(lb.targets).flatMap((t) => arr(obj(t)?.health_status).map((h) => str(obj(h)?.status) ?? "unknown"));
  const targets = arr(lb.targets).length;
  if (targets === 0) return { health: "unknown", detail: "no targets" };
  const healthy = checks.filter((c) => c === "healthy").length;
  const unhealthy = checks.filter((c) => c === "unhealthy").length;
  const detail = `${targets} target${targets === 1 ? "" : "s"} · ${healthy}/${checks.length} checks healthy`;
  if (checks.length === 0 || healthy + unhealthy === 0) return { health: "unknown", detail };
  if (unhealthy === 0) return { health: "healthy", detail };
  return { health: healthy === 0 ? "down" : "degraded", detail };
}

export function mapLoadBalancers(json: unknown): CloudResource[] {
  return each(json).flatMap((l) => {
    const id = str(l.id);
    if (id === undefined) return [];
    const h = loadBalancerHealth(l);
    const ip = str(obj(obj(l.public_net)?.ipv4)?.ip);
    return [cloudResource(PROVIDER, {
      id: `hcloud:load-balancer:${id}`, type: "loadbalancer", service: "load-balancer", name: str(l.name), region: locationOf(l),
      status: str(obj(l.load_balancer_type)?.name), tags: labels(l.labels), consoleUrl: CONSOLE, hosts: ip !== undefined ? [ip] : undefined,
      createdAt: isoTime(l.created), health: h.health, healthDetail: h.detail,
    })];
  });
}

export function mapVolumes(json: unknown): CloudResource[] {
  return each(json).flatMap((v) => {
    const id = str(v.id);
    if (id === undefined) return [];
    const size = str(v.size);
    return [cloudResource(PROVIDER, {
      id: `hcloud:volume:${id}`, type: "storage", service: "volume", name: str(v.name), region: locationOf(v),
      status: `${str(v.status) ?? "unknown"}${size !== undefined ? ` · ${size} GB` : ""}`, tags: labels(v.labels), consoleUrl: CONSOLE,
      createdAt: isoTime(v.created),
    })];
  });
}

/** `hcloud context list` as JSON (newer CLIs) or its text table ("*" marks the active one). */
export function parseContexts(stdout: string): CliAccount[] {
  const json = parseJson(stdout);
  if (Array.isArray(json)) {
    return each(json).flatMap((c) => {
      const name = str(c.name);
      return name !== undefined ? [{ id: name, label: name, current: c.active === true }] : [];
    });
  }
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !/^\s*ACTIVE\b/i.test(line))
    .flatMap((line) => {
      const name = line.trim().replace(/^\*\s*/, "").split(/\s+/)[0];
      return name !== undefined && name.length > 0 ? [{ id: name, label: name, current: line.trim().startsWith("*") }] : [];
    });
}

const LISTINGS: { service: string; args: string[]; map: (json: unknown) => CloudResource[] }[] = [
  { service: "servers", args: ["server", "list"], map: mapServers },
  { service: "load balancers", args: ["load-balancer", "list"], map: mapLoadBalancers },
  { service: "volumes", args: ["volume", "list"], map: mapVolumes },
];

export class HetznerIntegration extends CliCloudAdapter {
  readonly id = PROVIDER;
  readonly name = "Hetzner Cloud";
  protected readonly binName = "hcloud";
  protected readonly setupHint = "brew install hcloud && hcloud context create <project>";
  protected readonly accountPattern = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,99}$/;
  protected readonly accountNoun = "context";
  protected override runOptions = { input: "" };

  private contextArgs(context: string | undefined): string[] {
    return context !== undefined ? ["--context", context] : [];
  }

  protected async accounts(bin: string): Promise<CliAccount[]> {
    return parseContexts(await this.run(bin, ["context", "list", "-o", "noheader"])).filter((c) => this.accountPattern.test(c.id));
  }

  protected async check(bin: string, account: string | undefined): Promise<CheckResult> {
    try {
      await this.json(bin, ["location", "list", "-o", "json", ...this.contextArgs(account)]);
      return { ok: true, detail: `hcloud context ${account ?? "(active)"}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "hcloud failed";
      const loggedOut = /no active context|token|unauthori[sz]ed|401|not found/i.test(message);
      return { ok: false, status: loggedOut ? "not_connected" : "error", detail: message, setupHint: loggedOut ? "hcloud context create <project>" : this.setupHint };
    }
  }

  protected async list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]> {
    const lists = await mapLimit(LISTINGS, 3, (l) =>
      guarded(l.service, errors, async () => l.map(await this.json(bin, [...l.args, "-o", "json", ...this.contextArgs(account)]))),
    );
    return lists.flat();
  }
}
