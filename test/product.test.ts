// test/product.test.ts — product.json (CONTRACTS §23, docs/JOURNEYS.md): validation
// errors vs warnings, the product store (missing file, save, invalid file, watch,
// recheck), touch resolution against the map, and the hub's product messages.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { AcpBridge } from "../src/acp/bridge.js";
import type { Architecture } from "../src/contracts/architecture.js";
import { evidenceStrength, type ProductFile, validateProduct } from "../src/contracts/product.js";
import type { ServerMessage } from "../src/contracts/ws.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { createProductStore } from "../src/serve/product-store.js";
import { touchResolverFor } from "../src/serve/product-touches.js";
import { attachSession, projectInfoForStore, SessionHub } from "../src/serve/session.js";

// The bank example from JOURNEYS.md §2.3.
function bank(): ProductFile {
  return {
    version: 1,
    personas: [{ id: "retail", name: "Retail customer", goals: ["Know if I'm fine this month", "Pay bills fast"] }],
    screens: [
      { id: "home", name: "Home", route: "/home", path: "web/src/routes/home.tsx", node: "web", source: "scan" },
      { id: "transfer-new", name: "New transfer", route: "/transfer/new", path: "web/src/routes/transfer/new.tsx", node: "web", source: "scan" },
    ],
    journeys: [
      {
        id: "pay-rent",
        name: "Pay rent",
        persona: "retail",
        goal: "Pay my rent before the 1st",
        priority: "core",
        why: "Paying a known person is the most frequent money-moving action.",
        signal: "Median time from app open to transfer sent < 30 s",
        steps: [
          {
            id: "check-balance",
            screen: "home",
            action: "Opens the app and reads the balance",
            why: "Checking the balance is the #1 reason people open a bank app.",
            touches: ["web", "ledger-db"],
            evidence: [{ quote: "I only open it to see if my salary landed.", source: "Interview — customer 4", date: "2026-09-10", kind: "past_behavior" }],
          },
          { id: "start-transfer", screen: "home", action: "Taps Transfer, right below the balance" },
          { id: "fill-and-send", screen: "transfer-new", action: "Picks the landlord, confirms, sends", question: "PIN under €50?", origin: "agent" },
        ],
        branches: [
          { from: "fill-and-send", when: "Insufficient funds", journey: "top-up", rejoin: "fill-and-send" },
          { from: "fill-and-send", when: "Edits the amount", to: "start-transfer" },
        ],
      },
      { id: "top-up", name: "Top up", goal: "Add money", steps: [{ id: "add", action: "Adds money from a card" }] },
    ],
  };
}

function errorsOf(product: unknown): string[] {
  const result = validateProduct(product);
  return result.ok ? [] : result.errors;
}

describe("validateProduct", () => {
  it("accepts the bank example and round-trips it", () => {
    const result = validateProduct(JSON.parse(JSON.stringify(bank())));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(bank());
  });

  it("rejects duplicate ids", () => {
    const p = bank();
    p.personas.push({ id: "retail", name: "Again" });
    p.journeys[0]!.steps.push({ id: "add", action: "x" }, { id: "add", action: "y" });
    const errors = errorsOf(p);
    expect(errors).toContain("duplicate persona id: retail");
    expect(errors).toContain("journey pay-rent: duplicate step id: add");
  });

  it("rejects ids that break the pattern", () => {
    const p = bank();
    p.screens[0]!.id = "Home Screen";
    p.journeys[0]!.steps[0]!.screen = "Home Screen";
    expect(errorsOf(p).some((e) => e.startsWith("screen Home Screen: id must match"))).toBe(true);
  });

  it("rejects unknown persona, screen and branch references", () => {
    const p = bank();
    p.journeys[0]!.persona = "nobody";
    p.journeys[0]!.steps[1]!.screen = "nowhere";
    p.journeys[0]!.branches = [
      { from: "ghost", when: "a", to: "check-balance" },
      { from: "check-balance", when: "b", to: "ghost" },
      { from: "check-balance", when: "c", journey: "ghost" },
      { from: "check-balance", when: "d", journey: "top-up", rejoin: "ghost" },
    ];
    const errors = errorsOf(p);
    expect(errors).toContain("journey pay-rent: persona references unknown persona: nobody");
    expect(errors).toContain("journey pay-rent: step start-transfer: screen references unknown screen: nowhere");
    expect(errors).toContain('journey pay-rent: branch from ghost ("a"): from references unknown step: ghost');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("b"): to references unknown step: ghost');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("c"): journey references unknown journey: ghost');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("d"): rejoin references unknown step: ghost');
  });

  it("rejects malformed branches", () => {
    const p = bank();
    p.journeys[0]!.branches = [
      { from: "check-balance", when: "both", to: "start-transfer", journey: "top-up" },
      { from: "check-balance", when: "neither" },
      { from: "check-balance", when: "self", journey: "pay-rent" },
      { from: "check-balance", when: "loose rejoin", to: "start-transfer", rejoin: "start-transfer" },
    ];
    const errors = errorsOf(p);
    expect(errors).toContain('journey pay-rent: branch from check-balance ("both"): needs exactly one of to / journey');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("neither"): needs exactly one of to / journey');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("self"): journey cannot be its own journey');
    expect(errors).toContain('journey pay-rent: branch from check-balance ("loose rejoin"): rejoin needs journey');
  });

  it("rejects a journey with no steps and fields over their caps", () => {
    const p = bank();
    p.journeys[1]!.steps = [];
    p.journeys[0]!.steps[0]!.action = "x".repeat(201);
    const errors = errorsOf(p);
    expect(errors.some((e) => e.startsWith("journeys.1.steps:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("journeys.0.steps.0.action:"))).toBe(true);
  });

  it("rejects a screen path that escapes the repo", () => {
    const p = bank();
    p.screens[0]!.path = "../elsewhere/home.tsx";
    expect(errorsOf(p)).toContain("screen home: path escapes repo: ../elsewhere/home.tsx");
  });

  it("reports missing screen files and broken touches as warnings, not errors", () => {
    const root = mkdtempSync(join(tmpdir(), "ruah-product-"));
    const result = validateProduct(bank(), { root, resolveTouch: (ref) => ref === "web" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContain("screen home: path does not exist on disk: web/src/routes/home.tsx");
    expect(result.warnings).toContain("journey pay-rent: step check-balance: broken link: ledger-db");
    expect(result.warnings.some((w) => w.includes("broken link: web"))).toBe(false);
  });

  it("derives evidence strength from its kind", () => {
    expect(evidenceStrength({ quote: "q", kind: "opinion" })).toBe(0);
    expect(evidenceStrength({ quote: "q", kind: "launch_data" })).toBe(7);
    expect(evidenceStrength({ quote: "q" })).toBeUndefined();
    expect(evidenceStrength({ quote: "q", kind: "gut feeling" })).toBeUndefined();
  });
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ruah-product-store-"));
}

describe("product store", () => {
  it("a missing file is an empty state, not an error; the first save creates it", async () => {
    const root = tmpRoot();
    const store = createProductStore(join(root, "product.json"), { watch: false });
    const events: { reason: string; product: ProductFile | null }[] = [];
    const errors: string[] = [];
    store.onChange((e) => events.push({ reason: e.reason, product: e.product }));
    store.onError((e) => errors.push(e.message));
    await store.load();
    expect(events).toEqual([{ reason: "initial", product: null }]);
    expect(errors).toEqual([]);

    await store.save(bank(), { by: { kind: "user" } });
    expect(existsSync(join(root, "product.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "product.json"), "utf8"))).toEqual(bank());
    expect(events.at(-1)?.reason).toBe("saved");
    expect(store.revision).toBe(2);
    store.close();
  });

  it("save rejects an invalid product and leaves the file alone", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "product.json"), JSON.stringify(bank()));
    const store = createProductStore(join(root, "product.json"), { watch: false });
    await store.load();
    const bad = bank();
    bad.journeys[0]!.persona = "nobody";
    await expect(store.save(bad)).rejects.toThrow("unknown persona: nobody");
    expect(JSON.parse(readFileSync(join(root, "product.json"), "utf8"))).toEqual(bank());
    expect(store.revision).toBe(1);
    store.close();
  });

  it("an invalid file keeps the last good revision and emits an error", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "product.json"), JSON.stringify(bank()));
    const store = createProductStore(join(root, "product.json"), { watch: false });
    await store.load();
    const errors: string[] = [];
    store.onError((e) => errors.push(e.message));
    writeFileSync(join(root, "product.json"), "{ not json");
    await store.load();
    expect(errors).toHaveLength(1);
    expect(store.current()?.journeys[0]?.id).toBe("pay-rent");
    expect(store.revision).toBe(1);
    store.close();
  });

  it("watch picks up an edit, ignores its own write, and goes back to null when the file is deleted", async () => {
    const root = tmpRoot();
    const file = join(root, "product.json");
    const store = createProductStore(file, { watch: true });
    await store.load();
    const reasons: string[] = [];
    store.onChange((e) => reasons.push(`${e.reason}:${e.product === null ? "null" : e.product.journeys.length}`));
    await store.save(bank());
    await new Promise((r) => setTimeout(r, 400));
    expect(reasons).toEqual(["saved:2"]); // no echo of our own write
    const edited = bank();
    edited.journeys.pop();
    edited.journeys[0]!.branches = [];
    writeFileSync(file, JSON.stringify(edited));
    await new Promise((r) => setTimeout(r, 400));
    expect(reasons.at(-1)).toBe("changed:1");
    const { rmSync } = await import("node:fs");
    rmSync(file);
    await new Promise((r) => setTimeout(r, 400));
    expect(reasons.at(-1)).toBe("changed:null");
    store.close();
  });

  it("recheck notifies only when the warnings change", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "product.json"), JSON.stringify(bank()));
    let known = new Set(["web", "ledger-db"]);
    const store = createProductStore(join(root, "product.json"), { watch: false, touchResolver: () => (ref) => known.has(ref) });
    await store.load();
    expect(store.warnings().filter((w) => w.includes("broken link"))).toEqual([]);
    const events: string[][] = [];
    store.onChange((e) => events.push(e.warnings.filter((w) => w.includes("broken link"))));
    store.recheck();
    expect(events).toEqual([]);
    known = new Set(["web"]);
    store.recheck();
    expect(events).toEqual([["journey pay-rent: step check-balance: broken link: ledger-db"]]);
    store.close();
  });
});

describe("touchResolverFor", () => {
  it("resolves stored elements, workflows and expanded files; nothing else", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "web", "src"), { recursive: true });
    writeFileSync(join(root, "web", "src", "App.tsx"), "export function App() { return null; }\n");
    writeFileSync(join(root, "web", "src", "main.tsx"), "import { App } from './App';\nApp();\n");
    const arch: Architecture = {
      version: 1,
      name: "bank",
      nodes: [
        { id: "web", type: "frontend", name: "web", path: "web" },
        { id: "ledger-db", type: "datastore", name: "ledger" },
      ],
      edges: [],
      workflows: [{ id: "request", name: "Request", steps: ["web", "ledger-db"] }],
    };
    writeFileSync(join(root, "architecture.json"), JSON.stringify(arch));
    const archStore = createArchitectureStore(join(root, "architecture.json"), { watch: false });
    expect(touchResolverFor(archStore)).toBeUndefined(); // nothing loaded yet: not checked
    await archStore.load();
    const resolve = touchResolverFor(archStore)!;
    expect(resolve("web")).toBe(true);
    expect(resolve("request")).toBe(true);
    expect(resolve("web/src")).toBe(true);
    expect(resolve("web/src/App.tsx")).toBe(true);
    expect(resolve("web/src/Gone.tsx")).toBe(false);
    expect(resolve("payments")).toBe(false);
    archStore.close();
  });
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  products(): Extract<ServerMessage, { type: "product" }>[] {
    return this.sent.flatMap((m) => (m.type === "product" ? [m] : []));
  }
}

describe("SessionHub: product messages", () => {
  it("sends product after hello, saves product.save, and re-checks links when the map changes", async () => {
    const root = tmpRoot();
    const arch: Architecture = {
      version: 1,
      name: "bank",
      nodes: [
        { id: "web", type: "frontend", name: "web" },
        { id: "ledger-db", type: "datastore", name: "ledger" },
      ],
      edges: [],
      workflows: [],
    };
    writeFileSync(join(root, "architecture.json"), JSON.stringify(arch));
    const archStore = createArchitectureStore(join(root, "architecture.json"), { watch: false });
    await archStore.load();
    const product = createProductStore(join(root, "product.json"), { watch: false, touchResolver: () => touchResolverFor(archStore) });
    await product.load();

    const idle = {
      start: async () => {},
      stop: async () => {},
      status: () => "idle",
      on: () => () => {},
    } as unknown as AcpBridge;
    const hub = new SessionHub(archStore, idle, { version: "t", links: false, debug: () => {}, info: () => {} });
    hub.setProject({ info: projectInfoForStore(archStore), store: archStore, product });
    const socket = new FakeSocket();
    attachSession(hub, socket as unknown as WebSocket);
    socket.receive({ type: "hello", protocol: 1, client: "test/0" });
    expect(socket.products().at(-1)).toMatchObject({ reason: "initial", product: null, warnings: [] });

    socket.receive({ type: "product.save", product: bank() });
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.products().at(-1)).toMatchObject({ reason: "saved", by: { kind: "user" } });
    expect(existsSync(join(root, "product.json"))).toBe(true);

    // The agent (or the user) removes ledger-db from the map: the journey link breaks.
    await archStore.save({ ...arch, nodes: arch.nodes.filter((n) => n.id !== "ledger-db") });
    expect(socket.products().at(-1)).toMatchObject({ reason: "recheck" });
    expect(socket.products().at(-1)?.warnings).toContain("journey pay-rent: step check-balance: broken link: ledger-db");

    const bad = bank();
    bad.journeys[0]!.persona = "nobody";
    socket.receive({ type: "product.save", product: bad });
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.sent.at(-1)).toMatchObject({ type: "error", code: "product_save_rejected" });
    hub.setProject(null);
  });
});
