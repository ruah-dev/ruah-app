// src/integrations/health.ts — CONTRACTS.md §9: one "is it up right now?"
// vocabulary for every provider. Adapters map native states through a table
// (exact, case-insensitive) or the workload rule (ready vs desired replicas);
// the summary counts feed the Cloud page strip and `ruah app cloud status`.
// Pure; no I/O.
import type { CloudHealth, CloudResource } from "../contracts/integrations.js";

export type HealthTable = Readonly<Record<string, CloudHealth>>;

/** Native status → health via a lower-cased lookup; undefined when the status is absent. */
export function healthFrom(status: string | undefined, table: HealthTable): CloudHealth | undefined {
  if (status === undefined || status.length === 0) return undefined;
  return table[status.toLowerCase()] ?? "unknown";
}

/** Sets health (+ detail) on a mapped resource; a no-op for an undefined health. */
export function withHealth(resource: CloudResource, health: CloudHealth | undefined, detail?: string): CloudResource {
  if (health === undefined) return resource;
  return { ...resource, health, ...(detail !== undefined && detail.length > 0 ? { healthDetail: detail } : {}) };
}

export interface WorkloadState {
  ready: number;
  desired: number;
  /** A rollout is in progress (new revision not fully rolled out yet). */
  updating?: boolean;
  /** Pods stuck in CrashLoopBackOff / ImagePullBackOff / … */
  crashLoop?: number;
  /** The rollout gave up (Kubernetes ProgressDeadlineExceeded). */
  stalled?: boolean;
}

/**
 * Replica-based health: all ready → healthy; none ready → down; some → degraded;
 * a rollout in progress (and not failing) → deploying; scaled to zero → unknown.
 */
export function workloadHealth(w: WorkloadState): { health: CloudHealth; detail: string } {
  const crash = w.crashLoop ?? 0;
  const parts = [`${w.ready}/${w.desired} ready`];
  if (crash > 0) parts.push(`${crash} crash-looping`);
  if (w.stalled === true) parts.push("rollout stalled");
  else if (w.updating === true) parts.push("rolling out");
  const detail = parts.join(" · ");
  if (w.desired === 0) return { health: "unknown", detail: "scaled to 0" };
  if (w.ready === 0) return { health: w.updating === true && crash === 0 && w.stalled !== true ? "deploying" : "down", detail };
  if (crash > 0 || w.stalled === true) return { health: "degraded", detail };
  if (w.updating === true) return { health: "deploying", detail };
  if (w.ready < w.desired) return { health: "degraded", detail };
  return { health: "healthy", detail };
}

export interface HealthSummary {
  healthy: number;
  degraded: number;
  down: number;
  deploying: number;
  unknown: number;
  /** Resources that carry a health at all. */
  total: number;
}

export function summarizeHealth(resources: readonly Pick<CloudResource, "health">[]): HealthSummary {
  const out: HealthSummary = { healthy: 0, degraded: 0, down: 0, deploying: 0, unknown: 0, total: 0 };
  for (const r of resources) {
    if (r.health === undefined) continue;
    out[r.health] += 1;
    out.total += 1;
  }
  return out;
}

/** "12 running · 1 degraded · 1 down · 2 deploying" (zero counts omitted; "running" = healthy). */
export function formatSummary(s: HealthSummary): string {
  const parts: string[] = [];
  if (s.healthy > 0) parts.push(`${s.healthy} running`);
  if (s.degraded > 0) parts.push(`${s.degraded} degraded`);
  if (s.down > 0) parts.push(`${s.down} down`);
  if (s.deploying > 0) parts.push(`${s.deploying} deploying`);
  if (s.unknown > 0) parts.push(`${s.unknown} unknown`);
  return parts.length > 0 ? parts.join(" · ") : "no live status";
}

export const isUnhealthy = (health: CloudHealth | undefined): boolean => health === "down" || health === "degraded";

// ---- tables for the existing providers ------------------------------------------

export const DO_HEALTH = {
  droplet: { active: "healthy", new: "deploying", off: "down", archive: "down" },
  database: { online: "healthy", creating: "deploying", migrating: "deploying", resizing: "deploying", forking: "deploying", offline: "down" },
  kubernetes: { running: "healthy", provisioning: "deploying", upgrading: "deploying", degraded: "degraded", error: "down", deleted: "down", invalid: "down" },
  loadbalancer: { active: "healthy", new: "deploying", errored: "down" },
} satisfies Record<string, HealthTable>;

export const AWS_HEALTH = {
  ec2: { running: "healthy", pending: "deploying", stopping: "down", stopped: "down", "shutting-down": "down", terminated: "down" },
  lambda: { active: "healthy", pending: "deploying", inactive: "unknown", failed: "down" },
  rds: {
    available: "healthy", "backing-up": "healthy", "storage-optimization": "healthy", maintenance: "degraded",
    creating: "deploying", modifying: "deploying", upgrading: "deploying", rebooting: "deploying", starting: "deploying",
    "configuring-enhanced-monitoring": "deploying", "configuring-log-exports": "deploying", renaming: "deploying", "resetting-master-credentials": "deploying",
    stopping: "down", stopped: "down", failed: "down", "storage-full": "down", "inaccessible-encryption-credentials": "down",
    "incompatible-network": "down", "incompatible-parameters": "down", "incompatible-restore": "down", "restore-error": "down", deleting: "down",
  },
  elasticache: {
    available: "healthy", snapshotting: "healthy", creating: "deploying", modifying: "deploying", "rebooting cache cluster nodes": "deploying",
    deleting: "down", deleted: "down", "incompatible-network": "down", "restore-failed": "down",
  },
  elbv2: { active: "healthy", provisioning: "deploying", active_impaired: "degraded", failed: "down" },
  cloudfront: { deployed: "healthy", inprogress: "deploying" },
  ecs: { active: "healthy", draining: "deploying", inactive: "down" },
} satisfies Record<string, HealthTable>;
