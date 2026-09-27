// ui/test/journeys.test.ts — the Journeys page's pure helpers (ui/src/lib/journeys.ts): touches
// resolved into lanes, the screen-flow graph, business coverage per element, product-health gaps.
import { describe, expect, it } from "vitest";
import type { Architecture, ProductFile } from "@/lib/contracts";
import {
  attentionCount,
  brokenTouches,
  dropDangling,
  evidenceStrength,
  flowGraph,
  journeyColumns,
  journeyCoverage,
  journeysByPersona,
  laneOfElement,
  productGaps,
  resolveTouch,
  slugId,
  stepsForElement,
} from "@/lib/journeys";

const ARCH: Architecture = {
  version: 1,
  name: "bank",
  nodes: [
    { id: "web", type: "frontend", name: "web", path: "web" },
    { id: "web-routes", type: "module", name: "routes", parent: "web", path: "web/src/routes" },
    { id: "api", type: "service", name: "api", path: "api" },
    { id: "api-routes", type: "module", name: "api routes", parent: "api" },
    { id: "ledger-db", type: "datastore", name: "ledger" },
    { id: "stripe", type: "external", name: "Stripe" },
  ],
  edges: [],
  workflows: [{ id: "transfer-request", name: "Transfer request", steps: ["web", "api", "ledger-db"] }],
};

const PRODUCT: ProductFile = {
  version: 1,
  personas: [{ id: "retail", name: "Retail customer" }],
  screens: [
    { id: "home", name: "Home", route: "/home", node: "web" },
    { id: "transfer-new", name: "New transfer", route: "/transfer/new", node: "web" },
    { id: "cards", name: "Cards", route: "/cards", node: "web" },
    { id: "top-up", name: "Top up", route: "/top-up", node: "web" },
  ],
  journeys: [
    {
      id: "pay-rent",
      name: "Pay rent",
      persona: "retail",
      goal: "Pay my rent",
      priority: "core",
      why: "Most frequent money-moving action.",
      steps: [
        { id: "balance", screen: "home", action: "Reads the balance", why: "First thing people check.", touches: ["web-routes/home.tsx#BalanceCard", "api-routes", "ledger-db"], evidence: [{ quote: "I check if my salary landed", kind: "past_behavior" }] },
        { id: "tap", action: "Taps Transfer" },
        { id: "send", screen: "transfer-new", action: "Sends", touches: ["transfer-request", "gone"], question: "PIN under €50?" },
      ],
      branches: [{ from: "send", when: "Insufficient funds", journey: "top-up-money", rejoin: "send" }],
    },
    { id: "top-up-money", name: "Top up", goal: "Add money", steps: [{ id: "add", screen: "top-up", action: "Adds money", touches: ["stripe"] }] },
  ],
};

const WARNINGS = ["journey pay-rent: step send: broken link: gone", "screen cards: path does not exist on disk: web/src/cards.tsx"];

describe("touches and lanes", () => {
  it("sorts elements into lanes by their own or an ancestor's type", () => {
    const byId = (id: string) => ARCH.nodes.find((n) => n.id === id);
    expect(laneOfElement(byId("web-routes"), ARCH)).toBe("frontend");
    expect(laneOfElement(byId("api-routes"), ARCH)).toBe("backend");
    expect(laneOfElement(byId("ledger-db"), ARCH)).toBe("data");
    expect(laneOfElement(byId("stripe"), ARCH)).toBe("data");
    expect(laneOfElement(undefined, ARCH)).toBe("backend");
  });

  it("resolves stored ids, expanded symbols, workflows and broken refs", () => {
    expect(resolveTouch("ledger-db", ARCH, new Set())).toMatchObject({ label: "ledger", type: "datastore", lane: "data", broken: false });
    expect(resolveTouch("web-routes/home.tsx#BalanceCard", ARCH, new Set())).toMatchObject({ label: "BalanceCard · home.tsx", type: "symbol", lane: "frontend", element: { id: "web-routes" } });
    expect(resolveTouch("transfer-request", ARCH, new Set())).toMatchObject({ type: "workflow", workflow: { id: "transfer-request" } });
    expect(resolveTouch("gone", ARCH, new Set(["gone"]))).toMatchObject({ broken: true });
    expect(brokenTouches(WARNINGS, "pay-rent", "send")).toEqual(new Set(["gone"]));
  });

  it("builds one column per step with its screen, lanes and branches", () => {
    const cols = journeyColumns(PRODUCT, PRODUCT.journeys[0]!, ARCH, WARNINGS);
    expect(cols.map((c) => c.screen?.id)).toEqual(["home", undefined, "transfer-new"]);
    expect(cols[0]!.lanes.frontend.map((t) => t.ref)).toEqual(["web-routes/home.tsx#BalanceCard"]);
    expect(cols[0]!.lanes.backend.map((t) => t.ref)).toEqual(["api-routes"]);
    expect(cols[0]!.lanes.data.map((t) => t.ref)).toEqual(["ledger-db"]);
    expect(cols[2]!.lanes.backend.map((t) => [t.ref, t.broken])).toEqual([["transfer-request", false], ["gone", true]]);
    expect(cols[2]!.branches?.[0]?.journey).toBe("top-up-money");
  });
});

describe("flowGraph", () => {
  it("connects screens by steps, keeps actions on the same screen off the graph, and adds branch edges", () => {
    const g = flowGraph(PRODUCT);
    const edges = g.edges.map((e) => `${e.from}->${e.to}${e.branch ? " (branch)" : ""}`);
    expect(edges).toEqual(["home->transfer-new", "transfer-new->top-up (branch)"]);
    const col = (id: string) => g.nodes.find((n) => n.id === id)!.x;
    expect(col("home")).toBeLessThan(col("transfer-new"));
    // top-up starts its own journey (depth 0), cards is in none: dimmed, in the last column.
    const cards = g.nodes.find((n) => n.id === "cards")!;
    expect(cards.orphan).toBe(true);
    expect(cards.x).toBeGreaterThanOrEqual(Math.max(...g.nodes.filter((n) => !n.orphan).map((n) => n.x)));
    expect(g.nodes.find((n) => n.id === "home")!.journeys).toEqual(["pay-rent"]);
  });

  it("filters to some journeys and draws a start node for a journey without screens", () => {
    const product: ProductFile = { ...PRODUCT, journeys: [{ id: "onboard", name: "Onboard", goal: "Sign up", steps: [{ id: "a", action: "Opens the app" }, { id: "b", screen: "home", action: "Lands home" }] }] };
    const g = flowGraph(product, { journeys: ["onboard"] });
    expect(g.nodes.map((n) => n.id)).toEqual(["entry:onboard", "home"]);
    expect(g.nodes[0]!.label).toBe("Start: Onboard");
    expect(g.edges.map((e) => e.label)).toEqual(["Lands home"]);
  });
});

describe("coverage and element lookups", () => {
  it("counts journeys per element, up the parent chain and through workflows and screens", () => {
    const c = journeyCoverage(PRODUCT, ARCH);
    expect(c.get("web")).toMatchObject({ journeys: 2, core: 1 });
    expect(c.get("api")).toMatchObject({ journeys: 1, core: 1 });
    expect(c.get("ledger-db")?.journeys).toBe(1);
    expect(c.get("stripe")).toMatchObject({ journeys: 1, core: 0 });
    expect(journeyCoverage(null, ARCH).size).toBe(0);
  });

  it("finds the steps that touch an element", () => {
    expect(stepsForElement(PRODUCT, ARCH, "api").map((h) => h.step.id)).toEqual(["balance", "send"]);
    expect(stepsForElement(PRODUCT, ARCH, "stripe").map((h) => `${h.journey.id}/${h.step.id}`)).toEqual(["top-up-money/add"]);
  });
});

describe("productGaps", () => {
  it("lists broken links first, then whys, signals, evidence, questions, unmapped screens", () => {
    const gaps = productGaps(PRODUCT, WARNINGS);
    const kinds = gaps.map((g) => g.kind);
    expect(kinds.slice(0, 2)).toEqual(["broken_link", "broken_link"]);
    expect(gaps.find((g) => g.kind === "missing_why" && g.step === "tap")).toBeDefined();
    expect(gaps.find((g) => g.kind === "no_signal" && g.journey === "pay-rent")).toBeDefined();
    expect(gaps.find((g) => g.kind === "open_question")?.title).toBe("PIN under €50?");
    expect(gaps.filter((g) => g.kind === "unmapped_screen").map((g) => g.screen)).toEqual(["cards"]);
    expect(gaps.find((g) => g.kind === "weak_evidence")).toBeUndefined(); // past_behavior is moderate
    expect(attentionCount(gaps)).toBe(gaps.filter((g) => g.severity !== "low").length);
  });

  it("flags weak and contradicting evidence on core journeys", () => {
    const weak: ProductFile = structuredClone(PRODUCT);
    weak.journeys[0]!.steps[0]!.evidence = [{ quote: "I'd use it", kind: "stated_preference" }, { quote: "Never tap there", stance: "contradicts", kind: "observed_behavior" }];
    const gaps = productGaps(weak, []).filter((g) => g.kind === "weak_evidence").map((g) => g.title);
    expect(gaps).toEqual(["Pay rent: evidence contradicts “Reads the balance”", "Pay rent: the best evidence is “Said they would”"]);
  });
});

describe("editing helpers", () => {
  it("slugId dedupes and falls back", () => {
    expect(slugId("Pay rent!", new Set(["pay-rent"]), "journey")).toBe("pay-rent-2");
    expect(slugId("???", new Set(), "journey")).toBe("journey");
    expect(evidenceStrength({ kind: "commitment" })).toBe(5);
  });

  it("dropDangling removes references to deleted things", () => {
    const p: ProductFile = structuredClone(PRODUCT);
    p.screens = p.screens.filter((s) => s.id !== "home");
    p.journeys = p.journeys.filter((j) => j.id !== "top-up-money");
    p.personas = [];
    dropDangling(p);
    expect(p.journeys[0]!.persona).toBeUndefined();
    expect(p.journeys[0]!.steps[0]!.screen).toBeUndefined();
    expect(p.journeys[0]!.branches).toBeUndefined();
  });

  it("groups journeys by persona, core first", () => {
    const groups = journeysByPersona(PRODUCT);
    expect(groups.map((g) => [g.persona?.id ?? null, g.journeys.map((j) => j.id)])).toEqual([["retail", ["pay-rent"]], [null, ["top-up-money"]]]);
  });
});
