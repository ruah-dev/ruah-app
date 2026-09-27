// test/product-ops.test.ts — agents editing journeys (CONTRACTS §23.5–23.6): the
// product ops (atomic, name references, cascades), the three-way undo, the read
// views, the ruah_* product tools through MapOpsService, the token-guarded
// /api/product endpoints, and the journey lines / block in the context pack.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import type { ProductFile } from "../src/contracts/product.js";
import { validateProduct } from "../src/contracts/product.js";
import type { ProductOp } from "../src/contracts/product-ops.js";
import { applyProductOps, ProductOpError, revertProductTurn } from "../src/product/ops.js";
import { stepsTouching, summarizeProduct, touchCovers } from "../src/product/read.js";
import { callMapTool } from "../src/mcp/tools.js";
import { httpMapBackend } from "../src/mcp/stdio-server.js";
import { MapOpsService, type MapOpsHost } from "../src/serve/map-ops.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { createProductStore } from "../src/serve/product-store.js";
import { touchResolverFor } from "../src/serve/product-touches.js";
import { handleMapOpsRequest } from "../src/serve/map-ops-http.js";
import { buildContextPack, buildJourneyPack } from "../src/context/pack.js";
import { ArchIndex } from "../src/context/graph.js";
import { createServer, type Server } from "node:http";

const ARCH: Architecture = {
  version: 1,
  name: "bank",
  nodes: [
    { id: "web", type: "frontend", name: "web", path: "web" },
    { id: "web-routes", type: "module", name: "routes", parent: "web", path: "web/src/routes" },
    { id: "api", type: "service", name: "api", path: "api" },
    { id: "ledger-db", type: "datastore", name: "ledger" },
  ],
  edges: [{ from: "web", to: "api" }, { from: "api", to: "ledger-db" }],
  workflows: [{ id: "transfer-request", name: "Transfer request", steps: ["web", "api", "ledger-db"] }],
};

const BASE: ProductFile = {
  version: 1,
  personas: [{ id: "retail", name: "Retail customer" }],
  screens: [
    { id: "home", name: "Home", route: "/home", node: "web", source: "scan" },
    { id: "transfer-new", name: "New transfer", route: "/transfer/new", node: "web", source: "scan" },
  ],
  journeys: [
    {
      id: "pay-rent",
      name: "Pay rent",
      persona: "retail",
      goal: "Pay my rent before the 1st",
      priority: "core",
      why: "Paying a known person is the most frequent money-moving action.",
      steps: [
        { id: "check-balance", screen: "home", action: "Reads the balance", why: "Balance is why people open the app.", touches: ["web-routes"] },
        { id: "start-transfer", screen: "home", action: "Taps Transfer" },
        { id: "send", screen: "transfer-new", action: "Sends the money", touches: ["transfer-request"], question: "PIN under €50?" },
      ],
    },
  ],
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-product-ops-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function valid(product: ProductFile): void {
  const result = validateProduct(product);
  expect(result.ok ? [] : result.errors).toEqual([]);
}

describe("applyProductOps", () => {
  it("creates a product from nothing: persona, screen, journey with steps; slugs and name references", () => {
    const out = applyProductOps(null, [
      { op: "add_persona", name: "Small business owner" },
      { op: "add_screen", name: "Invoices", route: "/invoices" },
      {
        op: "add_journey",
        name: "Send an invoice",
        persona: "small business owner",
        goal: "Get paid",
        steps: [{ action: "Opens invoices", screen: "Invoices" }, { action: "Sends the invoice" }],
      },
    ]);
    expect(out.product.personas[0]?.id).toBe("small-business-owner");
    expect(out.product.screens[0]).toMatchObject({ id: "invoices", source: "agent" });
    const journey = out.product.journeys[0]!;
    expect(journey).toMatchObject({ id: "send-an-invoice", persona: "small-business-owner", origin: "agent" });
    expect(journey.steps.map((s) => [s.id, s.screen, s.origin])).toEqual([
      ["opens-invoices", "invoices", "agent"],
      ["sends-the-invoice", undefined, "agent"],
    ]);
    expect(out.changes.map((c) => `${c.action}:${c.target}:${c.id}`)).toEqual(["add:persona:small-business-owner", "add:screen:invoices", "add:journey:send-an-invoice"]);
    valid(out.product);
  });

  it("inserts, moves, updates and removes steps; positions work as references", () => {
    const out = applyProductOps(BASE, [
      { op: "add_step", journey: "Pay rent", after: null, step: { action: "Opens the app" } },
      { op: "update_step", journey: "pay-rent", id: "3", patch: { why: "One tap from the balance.", question: null } },
      { op: "move_step", journey: "pay-rent", id: "send", after: "opens-the-app" },
      { op: "add_evidence", journey: "pay-rent", step: "check-balance", evidence: { quote: "I only check if my salary landed.", kind: "past_behavior" } },
    ]);
    const steps = out.product.journeys[0]!.steps;
    expect(steps.map((s) => s.id)).toEqual(["opens-the-app", "send", "check-balance", "start-transfer"]);
    expect(steps.find((s) => s.id === "start-transfer")?.why).toBe("One tap from the balance.");
    expect(steps.find((s) => s.id === "check-balance")?.evidence).toHaveLength(1);
    expect(out.changes[1]).toMatchObject({ action: "update", target: "step", id: "pay-rent/start-transfer", fields: ["why"] });
    expect(BASE.journeys[0]!.steps).toHaveLength(3); // base untouched
    valid(out.product);
  });

  it("cascades removals: screens off steps, personas off journeys, branches off removed journeys and steps", () => {
    const withBranches = applyProductOps(BASE, [
      { op: "add_journey", name: "Top up", goal: "Add money", steps: [{ action: "Adds money" }] },
      { op: "add_branch", journey: "pay-rent", branch: { from: "send", when: "Insufficient funds", journey: "top-up", rejoin: "send" } },
      { op: "add_branch", journey: "pay-rent", branch: { from: "send", when: "Edits the amount", to: "start-transfer" } },
    ]).product;
    valid(withBranches);
    const out = applyProductOps(withBranches, [
      { op: "remove_screen", id: "home" },
      { op: "remove_persona", id: "retail" },
      { op: "remove_journey", id: "top-up" },
      { op: "remove_step", journey: "pay-rent", id: "start-transfer" },
    ]).product;
    const journey = out.journeys[0]!;
    expect(journey.persona).toBeUndefined();
    expect(journey.steps.map((s) => s.screen)).toEqual([undefined, "transfer-new"]);
    expect(journey.branches).toBeUndefined();
    valid(out);
  });

  it("scanned screens an agent edits become its own", () => {
    const out = applyProductOps(BASE, [{ op: "update_screen", id: "home", patch: { name: "Dashboard" } }]);
    expect(out.product.screens[0]).toMatchObject({ name: "Dashboard", source: "agent" });
  });

  it("is atomic and names the failing op", () => {
    let error: unknown;
    try {
      applyProductOps(BASE, [
        { op: "add_persona", name: "Admin" },
        { op: "update_step", journey: "pay-rent", id: "nope", patch: { why: "x" } },
      ]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProductOpError);
    expect((error as Error).message).toMatch(/op 2 of 2 \(update_step\): journey pay-rent has no step "nope".*nothing was changed/);
    expect(() => applyProductOps(BASE, [{ op: "remove_step", journey: "pay-rent", id: "1" }, { op: "remove_step", journey: "pay-rent", id: "1" }, { op: "remove_step", journey: "pay-rent", id: "1" }])).toThrow(/only step of pay-rent/);
    expect(() => applyProductOps(BASE, [{ op: "add_journey", id: "pay-rent", name: "x", goal: "y", steps: [{ action: "z" }] }])).toThrow(/id "pay-rent" is taken/);
    expect(() => applyProductOps(BASE, [{ op: "update_journey", id: "pay", patch: { name: "x" } }])).toThrow(/did you mean pay-rent/);
    expect(() => applyProductOps(BASE, [{ op: "remove_branch", journey: "pay-rent", from: "send", when: "never" }])).toThrow(/no branch from send/);
  });
});

describe("revertProductTurn", () => {
  it("restores what the turn changed and keeps what the user changed since", () => {
    const after = applyProductOps(BASE, [
      { op: "add_journey", name: "Freeze card", goal: "Stop a lost card", steps: [{ action: "Taps Freeze" }] },
      { op: "update_journey", id: "pay-rent", patch: { signal: "< 30 s" } },
      { op: "remove_screen", id: "transfer-new" },
      { op: "update_persona", id: "retail", patch: { description: "Salary earners" } },
    ]).product;
    // Later, the user edits the persona again: that one stays.
    const current = structuredClone(after);
    current.personas[0]!.description = "Salary earners, 25–45";
    const out = revertProductTurn(current, BASE, after);
    expect(out.product.journeys.map((j) => j.id)).toEqual(["pay-rent"]);
    expect(out.product.journeys[0]!.signal).toBeUndefined();
    expect(out.product.screens.map((s) => s.id)).toEqual(["home", "transfer-new"]);
    expect(out.product.personas[0]!.description).toBe("Salary earners, 25–45");
    expect(out.skipped).toEqual(["persona retail"]);
    valid(out.product);
  });

  it("undoing the turn that created product.json empties it", () => {
    const after = applyProductOps(null, [{ op: "add_persona", name: "Admin" }]).product;
    const out = revertProductTurn(after, null, after);
    expect(out.product).toEqual({ version: 1, personas: [], screens: [], journeys: [] });
  });
});

describe("read views", () => {
  it("touchCovers follows expanded ids, the parent chain and workflows", () => {
    expect(touchCovers("web", "web", ARCH)).toBe(true);
    expect(touchCovers("web/src/App.tsx#App", "web", ARCH)).toBe(true);
    expect(touchCovers("web-routes", "web", ARCH)).toBe(true);
    expect(touchCovers("web-routes/home.tsx", "web", ARCH)).toBe(true);
    expect(touchCovers("transfer-request", "ledger-db", ARCH)).toBe(true);
    expect(touchCovers("api", "web", ARCH)).toBe(false);
  });

  it("stepsTouching finds steps by touches and by their screen's element", () => {
    const hits = stepsTouching(BASE, "web", ARCH).map((h) => `${h.step.id}:${h.via}`);
    expect(hits).toEqual(["check-balance:web-routes", "start-transfer:screen", "send:transfer-request"]);
    expect(stepsTouching(BASE, "ledger-db", ARCH).map((h) => h.step.id)).toEqual(["send"]);
  });

  it("summarizeProduct lists everything, flags missing whys and open questions", () => {
    const text = summarizeProduct(BASE, ["journey pay-rent: step send: broken link: gone"]);
    expect(text).toContain("- pay-rent · Pay rent (Retail customer, core)");
    expect(text).toContain("2. start-transfer · Home /home · Taps Transfer");
    expect(text).toContain("why: (missing)");
    expect(text).toContain("question: PIN under €50?");
    expect(text).toContain("broken link: gone");
    expect(summarizeProduct(null, [])).toMatch(/No product.json yet/);
    expect(summarizeProduct(BASE, [], "nope")).toMatch(/unknown journey "nope"/);
  });
});

async function project() {
  const dir = tmp();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "architecture.json"), JSON.stringify(ARCH));
  writeFileSync(join(repo, "product.json"), JSON.stringify(BASE));
  const store = createArchitectureStore(join(repo, "architecture.json"), { watch: false });
  await store.load();
  const product = createProductStore(join(repo, "product.json"), { watch: false, touchResolver: () => touchResolverFor(store) });
  await product.load();
  let turnId: string | undefined = "turn-1";
  const recorded: string[] = [];
  const host: MapOpsHost = {
    store,
    product,
    agentId: () => "claude",
    activeTurnId: () => turnId,
    recordMapChanges: (_t, changes) => recorded.push(...changes.map((c) => `${c.target}:${c.id}`)),
  };
  const service = new MapOpsService(() => host, { version: "t" });
  const ctx = { agentId: "claude", root: store.root };
  return { repo, store, product, service, ctx, recorded, endTurn: () => (turnId = undefined) };
}

describe("product tools through MapOpsService", () => {
  it("read, apply (one save, provenance), journeys_for, and undo together with map changes", async () => {
    const { service, ctx, product, store, repo, recorded } = await project();
    const backend = service.backendFor(ctx);
    const saves: string[] = [];
    product.onChange((e) => saves.push(`${e.reason}:${e.by?.kind ?? "-"}:${(e.changes ?? []).length}`));

    const read = await callMapTool("ruah_get_product", {}, backend);
    expect(read.isError).toBeUndefined();
    expect(read.content[0]?.text).toContain("pay-rent · Pay rent");

    const ops: ProductOp[] = [
      { op: "add_step", journey: "pay-rent", step: { action: "Sees the confirmation", touches: ["ledger-db"] } },
      { op: "update_step", journey: "pay-rent", id: "start-transfer", patch: { question: "Why is Transfer below the balance?" } },
    ];
    const applied = await callMapTool("ruah_product_apply", { ops }, backend);
    expect(applied.isError).toBeUndefined();
    expect(applied.content[0]?.text).toMatch(/added step sees-the-confirmation[\s\S]*product.json saved/);
    expect(saves).toEqual(["saved:agent:2"]);
    const onDisk = JSON.parse(readFileSync(join(repo, "product.json"), "utf8")) as ProductFile;
    expect(onDisk.journeys[0]!.steps.at(-1)).toMatchObject({ id: "sees-the-confirmation", origin: "agent" });
    expect(recorded).toEqual(["step:pay-rent/sees-the-confirmation", "step:pay-rent/start-transfer"]);

    // A map change in the same turn.
    await backend.apply([{ op: "add_element", name: "Fraud check", type: "service" }]);

    const forLedger = await callMapTool("ruah_journeys_for", { element: "ledger" }, backend);
    expect(forLedger.content[0]?.text).toContain('step 3 of 4 send "Sends the money" via transfer-request');
    expect(forLedger.content[0]?.text).toContain('step 4 of 4 sees-the-confirmation');

    const journey = await callMapTool("ruah_get_journey", { id: "Pay rent" }, backend);
    const parsed = JSON.parse(journey.content[0]!.text) as { steps: { touches: { ref: string; element?: unknown; workflow?: unknown }[] }[] };
    expect(parsed.steps[0]!.touches[0]).toMatchObject({ ref: "web-routes", element: { id: "web-routes" } });
    expect(parsed.steps[2]!.touches[0]).toMatchObject({ ref: "transfer-request", workflow: { id: "transfer-request" } });

    const bad = await callMapTool("ruah_product_apply", { ops: [{ op: "remove_journey", id: "nope" }] }, backend);
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/unknown journey "nope"/);

    const undone = await service.undoTurn("turn-1");
    expect(undone.changes.map((c) => `${c.action}:${c.target}:${c.id}`)).toEqual(["remove:element:fraud-check", "update:journey:pay-rent"]);
    expect(product.current()).toEqual(BASE);
    expect(store.current()?.nodes.some((n) => n.id === "fraud-check")).toBe(false);
  });

  it("warns about touches that do not resolve", async () => {
    const { service, ctx } = await project();
    const res = await service.applyProduct(ctx, [{ op: "update_step", journey: "pay-rent", id: "2", patch: { touches: ["payments"] } }]);
    expect(res.warnings).toContain("journey pay-rent: step start-transfer: broken link: payments");
  });
});

describe("/api/product endpoints and the stdio backend", () => {
  it("need the token and serve read + ops", async () => {
    const { service, ctx, product } = await project();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleMapOpsRequest(req, res, url, service)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    expect((await fetch(`${url}/api/product`)).status).toBe(401);
    const token = service.issueToken(ctx);
    expect((await fetch(`${url}/api/product/ops`, { method: "POST", headers: { "x-ruah-token": token }, body: JSON.stringify({ ops: [{ op: "explode" }] }) })).status).toBe(400);

    const backend = httpMapBackend(url, token);
    const read = await backend.readProduct!();
    expect(read.product?.journeys[0]?.id).toBe("pay-rent");
    const res = await backend.applyProduct!([{ op: "add_persona", name: "Admin" }]);
    expect(res.changes[0]).toMatchObject({ action: "add", target: "persona", id: "admin" });
    expect(product.current()?.personas.map((p) => p.id)).toEqual(["retail", "admin"]);
    const tool = await callMapTool("ruah_product_apply", { ops: [{ op: "remove_persona", id: "zzz" }] }, backend);
    expect(tool.isError).toBe(true);
    expect(tool.content[0]?.text).toMatch(/unknown persona "zzz"/);
  });
});

describe("context pack", () => {
  const index = new ArchIndex(ARCH, "/repo");

  it("lists the journeys an element serves after the workflows", () => {
    const pack = buildContextPack(index, "ledger-db", "/repo", "why is it slow?", { mapTools: true, product: BASE });
    expect(pack).toContain(['journeys:', '- Pay rent (Retail customer, core): step 3 of 3 "Sends the money"', "  why: Paying a known person is the most frequent money-moving action.", "  question: PIN under €50?"].join("\n"));
    expect(pack).toContain("ruah_product_apply");
    // Without a product, the pack is exactly as before.
    const plain = buildContextPack(index, "ledger-db", "/repo", "q", { mapTools: true });
    expect(plain).not.toContain("journeys:");
    expect(plain).not.toContain("product.json");
  });

  it("adds the [ruah journey] block for a prompt sent from a step, with or without an element", () => {
    const withNode = buildContextPack(index, "web", "/repo", "make it faster", { product: BASE, journeyStep: { journey: "pay-rent", step: "start-transfer" } });
    expect(withNode).toContain("[/ruah context]\n[ruah journey]\njourney: Pay rent (Retail customer, core) id=pay-rent");
    expect(withNode).toContain("- 2. THIS Home /home: Taps Transfer");
    expect(withNode).toContain("step why: (not written yet)");
    expect(withNode).toContain("The user is working on the customer journey step marked THIS.");

    const alone = buildJourneyPack(BASE, { journey: "pay-rent", step: "check-balance" }, ARCH, "/repo", "add a hide-balance toggle", { mapTools: true });
    expect(alone.startsWith("[ruah journey]\n")).toBe(true);
    expect(alone).toContain("step why: Balance is why people open the app.");
    expect(alone).toContain("touches:\n- routes (module) id=web-routes path=web/src/routes");
    expect(alone.endsWith("\n\nadd a hide-balance toggle")).toBe(true);
    expect(() => buildJourneyPack(BASE, { journey: "pay-rent", step: "nope" }, ARCH, "/repo")).toThrow(/unknown step/);
  });
});
