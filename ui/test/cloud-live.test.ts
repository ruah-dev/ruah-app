// Viewer side of CONTRACTS.md §9: applying cloud.updated pushes, the health counts behind the
// Cloud page strip, and the health → tone mapping (status heuristic as fallback).
import { describe, expect, it } from "vitest";
import type { CloudResource, CloudSyncResult } from "@/lib/contracts";
import { applyCloudUpdate, pushOutdatesLoad, healthCounts, healthTone, isUnhealthy } from "@/lib/integrations";

const r = (id: string, provider: string, extra: Partial<CloudResource> = {}): CloudResource => ({
  id,
  provider,
  type: "app",
  service: "project",
  name: id,
  ...extra,
});

const prev: CloudSyncResult = {
  resources: [r("a", "vercel", { health: "healthy", observedAt: "t0" }), r("b", "kubernetes", { health: "down", observedAt: "t0" })],
  syncedAt: "t0",
  errors: [],
};

describe("applyCloudUpdate", () => {
  it("replaces the snapshot when the push carries resources", () => {
    const next = applyCloudUpdate(prev, {
      type: "cloud.updated",
      root: "/r",
      syncedAt: "t1",
      providers: ["vercel"],
      failed: [],
      errors: [],
      resources: [r("a", "vercel", { health: "deploying" })],
    });
    expect(next.resources.map((x) => x.health)).toEqual(["deploying"]);
    expect(next.syncedAt).toBe("t1");
  });

  it("without resources only refreshes observedAt of the synced (not failed) providers and the errors", () => {
    const next = applyCloudUpdate(prev, {
      type: "cloud.updated",
      root: "/r",
      syncedAt: "t1",
      providers: ["vercel", "kubernetes"],
      failed: ["kubernetes"],
      errors: [{ provider: "kubernetes", message: "cluster unreachable" }],
    });
    expect(next.resources.map((x) => [x.id, x.observedAt])).toEqual([
      ["a", "t1"],
      ["b", "t0"],
    ]);
    expect(next.errors).toEqual([{ provider: "kubernetes", message: "cluster unreachable" }]);
  });
});

describe("pushOutdatesLoad", () => {
  it("keeps a push that landed while the first load was in flight (a slow provider finished in between)", () => {
    expect(pushOutdatesLoad(true, 2_000, 1_000)).toBe(true);
    expect(pushOutdatesLoad(true, 1_000, 1_000)).toBe(true);
  });
  it("applies the load when no push arrived since it was requested", () => {
    expect(pushOutdatesLoad(true, 500, 1_000)).toBe(false);
    expect(pushOutdatesLoad(true, null, 1_000)).toBe(false);
    expect(pushOutdatesLoad(false, 2_000, 1_000)).toBe(false);
  });
});

describe("health helpers", () => {
  it("counts only resources with a health", () => {
    const c = healthCounts([...prev.resources, r("c", "aws")]);
    expect(c).toMatchObject({ healthy: 1, down: 1, total: 2 });
  });

  it("maps health to tones and falls back to the status heuristic", () => {
    expect(healthTone({ health: "down" })).toBe("bad");
    expect(healthTone({ health: "degraded" })).toBe("warn");
    expect(healthTone({ health: "healthy", status: "error" })).toBe("ok");
    expect(healthTone({ status: "running" })).toBe("ok");
    expect(isUnhealthy({ health: "degraded" })).toBe(true);
    expect(isUnhealthy({ health: "deploying" })).toBe(false);
  });
});
