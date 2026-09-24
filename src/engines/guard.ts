// src/engines/guard.ts — report-only secrets scan and audit log via ruah-guard.
// Never changes agent permissions.
import { runEngineJson, type EngineCliDeps } from "./cli.js";

export interface GuardScanReport {
  findings?: unknown[];
  summary?: {
    filesScanned?: number;
    filesSkipped?: number;
    total?: number;
    bySeverity?: Record<string, number>;
    failOn?: string;
    failed?: boolean;
  };
}

export interface GuardAuditReport {
  entries?: unknown[];
  count?: number;
  file?: string;
}

export async function runGuardScan(options: {
  root: string;
  deps?: EngineCliDeps;
}): Promise<{ ok: true; data: GuardScanReport } | { ok: false; status: number; error: string }> {
  const result = await runEngineJson<GuardScanReport>("guard", ["scan", "."], {
    cwd: options.root,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, data: result.data };
}

export async function runGuardAudit(options: {
  root: string;
  last?: number;
  deps?: EngineCliDeps;
}): Promise<{ ok: true; data: GuardAuditReport } | { ok: false; status: number; error: string }> {
  const last = options.last ?? 50;
  const result = await runEngineJson<GuardAuditReport>("guard", ["audit", "--last", String(last)], {
    cwd: options.root,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, data: result.data };
}
