// Infrastructure-as-code scanning (CONTRACTS.md §11): a standalone library —
// no daemon, no network, no writes. detectInfra(ctx) runs every detector and
// returns the raw report (`ruah app infra` prints it); buildInfraGraph()
// (graph.ts) maps a report onto an architecture for `ruah app scan`.
//
// Bounded: each detector caps the files it reads (Terraform 3,000, YAML
// 4,000, Dockerfiles 500, workflows 200) and every read is capped at 2 MiB by
// the walker's readText; files are read at most once per scan (readCached).
// Never read: terraform.tfstate*, *.tfvars, .env*, Secret manifests' data,
// Ansible group_vars / host_vars / inventory variables.
import { detectCompose, type ComposeService } from "../detectors/compose.js";
import { detectWorkspaces } from "../detectors/workspaces.js";
import type { ScanContext } from "../types.js";
import { detectAnsible } from "./ansible.js";
import { detectCi, resolvePipelines } from "./ci.js";
import { detectDockerfiles } from "./docker.js";
import { detectHelm } from "./helm.js";
import { detectKubernetes, helmChartDirs } from "./kubernetes.js";
import { byString, emptyReport, readCached, serviceHost, uniq, type InfraItem, type InfraLink, type InfraReport } from "./model.js";
import { detectTerraform } from "./terraform.js";

export * from "./model.js";
export { buildInfraGraph, type InfraGraph, type InfraGraphEnv } from "./graph.js";

export interface DetectInfraOptions {
  /** Compose services already detected by the caller (scanRepo); detected here otherwise. */
  compose?: ComposeService[];
}

export function detectInfra(ctx: ScanContext, opts: DetectInfraOptions = {}): InfraReport {
  const report = emptyReport();
  const charts = helmChartDirs(ctx);
  detectTerraform(ctx, report);
  detectKubernetes(ctx, report, charts);
  detectHelm(ctx, report, charts);
  detectAnsible(ctx, report);
  detectDockerfiles(ctx, report);
  addCompose(ctx, report, opts.compose ?? detectCompose(ctx, detectWorkspaces(ctx).dirs));
  detectCi(ctx, report);
  resolvePipelines(report);
  resolveCrossRefs(report);
  report.links = dedupeLinks(report.links);
  return report;
}

function addCompose(ctx: ScanContext, report: InfraReport, services: ComposeService[]): void {
  if (services.length === 0) return;
  const byFile = new Map<string, ComposeService[]>();
  for (const s of services) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  for (const [file, list] of [...byFile].sort((a, b) => byString(a[0], b[0]))) {
    const lines = (readCached(ctx, file) ?? "").split(/\r?\n/);
    const key = `compose:${file}`;
    report.groups.push({ key, tool: "compose", name: `Compose: ${file}`, kind: "compose file", files: [file], settings: { services: String(list.length) }, details: [], hints: [] });
    for (const s of list) {
      const line = lines.findIndex((l) => new RegExp(`^\\s{2,4}["']?${s.name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}["']?:\\s*$`).test(l)) + 1 || 1;
      const category = s.kind === undefined ? "workload" : s.kind.type === "datastore" ? "database" : s.kind.key === "redis" ? "cache" : s.kind.type === "queue" ? "queue" : s.kind.type === "gateway" ? "gateway" : "workload";
      report.items.push({
        key: `compose:${s.name}`,
        group: key,
        tool: "compose",
        kind: "service",
        address: `${file}#${s.name}`,
        name: s.name,
        category,
        file,
        line,
        settings: {
          ...(s.image !== undefined ? { image: s.image } : {}),
          ...(s.buildContext !== undefined ? { build: s.buildContext === "" ? "." : s.buildContext } : {}),
          ...(s.dependsOn.length > 0 ? { depends_on: s.dependsOn.join(", ") } : {}),
        },
        details: [],
        hints: [s.name],
        images: s.image !== undefined ? [s.image] : [],
        tech: [s.kind?.name ?? "Docker Compose"],
        ...(s.kind !== undefined ? { infraKind: s.kind.key } : {}),
      });
    }
  }
}

// Links whose ends name Kubernetes objects managed elsewhere (a Secret written
// by Terraform, a Helm value's host): resolved once every detector ran.
function resolveCrossRefs(report: InfraReport): void {
  const out: InfraLink[] = [];
  const k8sWorkloads = report.items.filter((i) => i.refs !== undefined && i.refs.length > 0);
  for (const l of report.links) {
    if ("item" in l.from && l.from.item.startsWith("k8sref:")) {
      const ref = l.from.item.slice(7);
      for (const w of k8sWorkloads) if (w.refs?.includes(ref)) out.push({ ...l, from: { item: w.key }, evidence: uniq([`${w.file}:${w.line}`, ...l.evidence]) });
      continue;
    }
    out.push(l);
  }
  // Helm workloads: hosts in values → another item of the same chart (dependency alias, other workload).
  for (const w of report.items.filter((i) => i.tool === "helm" && i.refs !== undefined)) {
    for (const r of w.refs ?? []) {
      if (!r.startsWith("host:")) continue;
      const host = serviceHost(r.slice(5));
      const target = report.items.find((x: InfraItem) => x.group === w.group && x.key !== w.key && x.hints.some((h) => h === host || host.endsWith(`-${h}`)));
      if (target !== undefined) out.push({ from: { item: w.key }, to: { item: target.key }, label: target.infraKind !== undefined ? "uses" : "calls", kind: target.category === "database" ? "data" : "sync", evidence: [`${w.file}:${w.line}`] });
    }
  }
  report.links = out;
}

function endKey(e: InfraLink["from"]): string {
  return JSON.stringify(e);
}

function dedupeLinks(links: InfraLink[]): InfraLink[] {
  const byKey = new Map<string, InfraLink>();
  for (const l of links) {
    const k = `${endKey(l.from)}\u0000${endKey(l.to)}\u0000${l.label}`;
    const prev = byKey.get(k);
    if (prev === undefined) byKey.set(k, { ...l, evidence: uniq(l.evidence).sort(byString).slice(0, 10) });
    else prev.evidence = uniq([...prev.evidence, ...l.evidence]).sort(byString).slice(0, 10);
  }
  return [...byKey.values()].sort((a, b) => byString(`${endKey(a.from)}${endKey(a.to)}${a.label}`, `${endKey(b.from)}${endKey(b.to)}${b.label}`));
}
