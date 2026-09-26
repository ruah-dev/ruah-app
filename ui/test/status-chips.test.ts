// ui/test/status-chips.test.ts — the top bar's status chips (ui/src/lib/status-chips.ts): the
// open project's cloud health chip (hidden without a provider), the agent's remaining-limit hint,
// and the integration slots that feed them (ui/src/components/shell/slots.ts).
import { describe, expect, it } from "vitest";
import type { CloudResource } from "@/lib/contracts";
import { cloudConnected, cloudHealthSummary, normalizeLimitHint } from "@/lib/status-chips";
import { registerStatusItem, setAgentLimitHint, slotsSnapshot } from "@/components/shell/slots";

type R = Pick<CloudResource, "name" | "health" | "status" | "scope">;
const res = (name: string, patch: Partial<R> = {}): R => ({ name, health: "healthy", ...patch });
/** A resource from an older provider: no health, maybe a status string. */
const bare = (name: string, status?: string): R => (status === undefined ? { name } : { name, status });
const inProject = { in: true, reasons: ["tag project=shop"] };
const elsewhere = { in: false, reasons: [] };

describe("cloudConnected", () => {
  it("uses the integrations list when loaded", () => {
    expect(cloudConnected([{ family: "cloud", status: "connected" }], null)).toBe(true);
    expect(cloudConnected([{ family: "cloud", status: "not_connected" }, { family: "work", status: "connected" }], null)).toBe(false);
    // The list wins over a snapshot left from an earlier connection.
    expect(cloudConnected([], { resources: [], syncedAt: "2026-09-26T10:00:00Z" })).toBe(false);
  });

  it("otherwise trusts a snapshot that was synced or holds resources", () => {
    expect(cloudConnected(null, null)).toBe(false);
    expect(cloudConnected(null, { resources: [], syncedAt: null })).toBe(false);
    expect(cloudConnected(null, { resources: [], syncedAt: "2026-09-26T10:00:00Z" })).toBe(true);
  });
});

describe("cloudHealthSummary", () => {
  it("is hidden with no provider or nothing in the project's scope", () => {
    expect(cloudHealthSummary([res("api")], false)).toBeNull();
    expect(cloudHealthSummary([], true)).toBeNull();
    expect(cloudHealthSummary([res("other", { scope: elsewhere })], true)).toBeNull();
  });

  it('says "9 ok · 1 degraded" for the project\'s resources only', () => {
    const resources = [
      ...Array.from({ length: 9 }, (_, i) => res(`svc${i}`, { scope: inProject })),
      res("worker", { health: "degraded", scope: inProject }),
      res("someone-else", { health: "down", scope: elsewhere }),
    ];
    expect(cloudHealthSummary(resources, true)).toMatchObject({
      tone: "warn",
      label: "9 ok · 1 degraded",
      short: "1 degraded",
      total: 10,
      unhealthy: ["worker"],
    });
  });

  it("puts down first, counts deploying, and leaves out resources without a health notion", () => {
    const s = cloudHealthSummary(
      [
        res("db", { health: "down" }),
        res("web", { health: "degraded" }),
        res("next", { health: "deploying" }),
        res("api"),
        // §9.2: no health = no health notion (domains, buckets, deployment rows), whatever the status.
        bare("old-preview", "error"),
        bare("new-db", "creating"),
        bare("bucket"),
      ],
      true,
    );
    expect(s).toMatchObject({
      tone: "bad",
      label: "1 ok · 1 degraded · 1 down · 1 deploying",
      short: "1 down",
      unhealthy: ["db", "web"],
      unrated: 3,
      total: 7,
    });
  });

  it("agrees with the Cloud page for a Vercel project and its deployment rows", () => {
    // 9 healthy + 1 degraded droplets, a healthy Vercel project, its failed preview deployment and
    // its live production deployment (rows with a status, no health: the project counts once).
    const resources = [
      ...Array.from({ length: 9 }, (_, i) => res(`droplet${i}`, { scope: inProject })),
      res("billing", { health: "degraded", scope: inProject }),
      res("shop-web", { scope: inProject }),
      { ...bare("shop-web preview", "error"), scope: inProject },
      { ...bare("shop-web production", "ready"), scope: inProject },
    ];
    expect(cloudHealthSummary(resources, true)).toMatchObject({
      tone: "warn",
      label: "10 ok · 1 degraded",
      unhealthy: ["billing"],
      unrated: 2,
      total: 13,
    });
  });

  it("reads status strings only from an older daemon (nothing carries a health)", () => {
    const s = cloudHealthSummary([bare("legacy-vm", "error"), bare("new-db", "creating"), bare("bucket"), bare("web", "degraded")], true);
    expect(s).toMatchObject({
      tone: "bad",
      label: "1 ok · 1 degraded · 1 down · 1 deploying",
      unhealthy: ["legacy-vm", "web"],
      unrated: 0,
    });
  });

  it("stays quiet when nothing in scope has a health notion", () => {
    expect(cloudHealthSummary([res("api", { scope: elsewhere }), { ...bare("example.com"), scope: inProject }], true)).toMatchObject({
      tone: "muted",
      label: "1 resource",
      unrated: 1,
    });
  });

  it("leaves unknown health out (scaled to 0, never ran)", () => {
    expect(cloudHealthSummary([res("a"), res("cron", { health: "unknown" })], true)).toMatchObject({
      tone: "ok",
      label: "1 ok",
      unknown: 1,
      total: 2,
    });
    expect(cloudHealthSummary([res("x", { health: "unknown" }), res("y", { health: "unknown" })], true)).toMatchObject({
      tone: "muted",
      label: "2 resources",
      short: "2 resources",
    });
  });
});

describe("normalizeLimitHint", () => {
  it("clears on null or blank", () => {
    expect(normalizeLimitHint(null)).toBeNull();
    expect(normalizeLimitHint(undefined)).toBeNull();
    expect(normalizeLimitHint("   ")).toBeNull();
    expect(normalizeLimitHint({ text: "" })).toBeNull();
  });

  it("turns amber at 25 % and red at 10 %, quiet otherwise", () => {
    expect(normalizeLimitHint("62% left")).toEqual({ text: "62% left", tone: "muted" });
    expect(normalizeLimitHint(" 25 % left ")).toEqual({ text: "25 % left", tone: "warn" });
    expect(normalizeLimitHint("8% remaining")).toEqual({ text: "8% remaining", tone: "bad" });
    expect(normalizeLimitHint("resets 14:00")).toEqual({ text: "resets 14:00", tone: "muted" });
  });

  it("keeps a given tone and detail", () => {
    expect(normalizeLimitHint({ text: "5% left", tone: "ok", detail: "weekly" })).toEqual({ text: "5% left", tone: "ok", detail: "weekly" });
    expect(normalizeLimitHint({ text: "20% left", detail: "5-hour window" })).toEqual({ text: "20% left", tone: "warn", detail: "5-hour window" });
  });
});

describe("shell slots", () => {
  it("sets and clears agent limit hints (normalized)", () => {
    setAgentLimitHint("claude", "9% left");
    setAgentLimitHint("codex", { text: "40% left", detail: "weekly" });
    expect(slotsSnapshot().limitHints).toEqual({
      claude: { text: "9% left", tone: "bad" },
      codex: { text: "40% left", tone: "muted", detail: "weekly" },
    });
    setAgentLimitHint("claude", null);
    setAgentLimitHint("codex", "  ");
    expect(slotsSnapshot().limitHints).toEqual({});
  });

  it("orders status items, replaces by id and removes only its own registration", () => {
    const A = () => null;
    const B = () => null;
    const B2 = () => null;
    const offA = registerStatusItem({ id: "a", render: A, order: 200 });
    const offB = registerStatusItem({ id: "b", render: B });
    expect(slotsSnapshot().statusItems.map((i) => i.id)).toEqual(["b", "a"]);
    const offB2 = registerStatusItem({ id: "b", render: B2, order: 300 });
    expect(slotsSnapshot().statusItems.map((i) => [i.id, i.render])).toEqual([
      ["a", A],
      ["b", B2],
    ]);
    offB(); // stale: the second registration of "b" stays
    expect(slotsSnapshot().statusItems.map((i) => i.id)).toEqual(["a", "b"]);
    offB2();
    offA();
    expect(slotsSnapshot().statusItems).toEqual([]);
  });
});
