// Viewer side of CONTRACTS.md §14: the Cloud page's "This project" / "All accounts" split, the
// counts the summary strip and the Unhealthy filter use in project mode, suggestions, the
// reason badge, the row menu's actions, and cloud.updated carrying the scope summary.
import { describe, expect, it } from "vitest";
import type { CloudResource, CloudSyncResult } from "@/lib/contracts";
import { applyCloudUpdate, healthCounts, inScope, isUnhealthy, scopeActions, scopeBadge, scopeView } from "@/lib/integrations";

const r = (id: string, extra: Partial<CloudResource> = {}): CloudResource => ({
  id,
  provider: "vercel",
  type: "app",
  service: "project",
  name: id,
  ...extra,
});

const snapshot: CloudResource[] = [
  r("mine-ok", { health: "healthy", scope: { in: true, confidence: "proof", reasons: ["from .vercel/project.json"] } }),
  r("mine-down", { health: "down", scope: { in: true, confidence: "likely", reasons: ["host shop.acme.ro in .env.example"] } }),
  r("added", { health: "healthy", scope: { in: true, confidence: "manual", reasons: ["added by you"] } }),
  r("suggested", { health: "down", scope: { in: false, confidence: "weak", reasons: ["name looks like acmeshop"] } }),
  r("removed", { health: "down", scope: { in: false, confidence: "manual", reasons: ["removed by you"], excluded: true } }),
  r("other-client", { health: "down", scope: { in: false, reasons: [] } }),
];

describe("scopeView", () => {
  it("splits the project's resources, suggestions and removed ones; counts follow the mode", () => {
    const v = scopeView(snapshot);
    expect(v.supported).toBe(true);
    expect(v.project.map((x) => x.id)).toEqual(["mine-ok", "mine-down", "added"]);
    expect(v.suggestions.map((x) => x.id)).toEqual(["suggested"]);
    expect(v.excluded.map((x) => x.id)).toEqual(["removed"]);
    // Project mode: the strip and the Unhealthy filter count only in-scope resources.
    const project = healthCounts(v.project);
    expect(project).toMatchObject({ healthy: 2, down: 1, total: 3 });
    expect(v.project.filter(isUnhealthy).map((x) => x.id)).toEqual(["mine-down"]);
    // All accounts: everything.
    expect(healthCounts(v.all)).toMatchObject({ healthy: 2, down: 4, total: 6 });
  });

  it("a daemon without §14 (no scope on any resource) shows everything as the project's", () => {
    const old = [r("a"), r("b", { health: "down" })];
    const v = scopeView(old);
    expect(v.supported).toBe(false);
    expect(v.project).toEqual(old);
    expect(v.suggestions).toEqual([]);
    expect(old.every(inScope)).toBe(true);
  });
});

describe("badge and row menu", () => {
  it("the badge is the strongest reason without its detail", () => {
    expect(scopeBadge({ in: true, confidence: "proof", reasons: ["from .do/app.yaml (app shop)", "tag project=shop"] })).toBe("from .do/app.yaml");
    expect(scopeBadge({ in: true, confidence: "proof", reasons: ["in Terraform (digitalocean_app.web)"] })).toBe("in Terraform");
    expect(scopeBadge({ in: true, confidence: "manual", reasons: ["added by you"] })).toBe("added by you");
    expect(scopeBadge({ in: false, reasons: [] })).toBeUndefined();
    expect(scopeBadge(undefined)).toBeUndefined();
  });

  it("offers Add / Remove / back to the evidence depending on the state", () => {
    expect(scopeActions(snapshot[0]!)).toEqual(["exclude"]);
    expect(scopeActions(snapshot[2]!)).toEqual(["exclude", "reset"]);
    expect(scopeActions(snapshot[3]!)).toEqual(["include"]);
    expect(scopeActions(snapshot[4]!)).toEqual(["include", "reset"]);
    expect(scopeActions(snapshot[5]!)).toEqual(["include"]);
    expect(scopeActions(r("no-scope"))).toEqual([]);
  });
});

describe("cloud.updated with a scope summary", () => {
  it("keeps the last summary when a push carries none, replaces it when it does", () => {
    const prev: CloudSyncResult = {
      resources: snapshot,
      syncedAt: "t0",
      errors: [],
      scope: { configured: false, accounts: [], files: [{ path: "/r/.ruah/cloud.json", exists: false }], writable: true },
    };
    const base = { type: "cloud.updated" as const, root: "/r", syncedAt: "t1", providers: ["vercel"], failed: [], errors: [] };
    expect(applyCloudUpdate(prev, base).scope).toEqual(prev.scope);
    const next = applyCloudUpdate(prev, {
      ...base,
      providers: [],
      resources: [r("mine-ok", { scope: { in: false, confidence: "manual", reasons: ["removed by you"], excluded: true } })],
      scope: { configured: true, accounts: [{ provider: "vercel", account: "acme" }], files: [{ path: "/r/.ruah/cloud.json", exists: true }], writable: true },
    });
    expect(next.scope?.accounts).toEqual([{ provider: "vercel", account: "acme" }]);
    expect(scopeView(next.resources).project).toEqual([]);
  });
});
