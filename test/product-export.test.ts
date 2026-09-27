// test/product-export.test.ts — sharing journeys (CONTRACTS §23.7, docs/JOURNEYS.md §8):
// the storyboard HTML, markdown, the lane rule, draw.io journey pages, the
// `ruah app journeys` CLI, `ruah app export drawio` with a product.json, and
// GET /api/product/export.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import type { ProductFile } from "../src/contracts/product.js";
import { journeysToDrawio, toDrawio } from "../src/export/drawio.js";
import { runExport } from "../src/export/run-export.js";
import { exportJourneys, loadScreenshots } from "../src/product/export.js";
import { describeTouch, laneOf, LANES } from "../src/product/lanes.js";
import { journeyMarkdown } from "../src/product/markdown.js";
import { journeyGaps, loadProduct, runJourneys } from "../src/product/run-journeys.js";
import { renderAllStoryboards, renderStoryboard } from "../src/product/storyboard.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { createProductStore } from "../src/serve/product-store.js";
import { touchResolverFor } from "../src/serve/product-touches.js";
import { projectInfoForStore, SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { ChatStore } from "../src/projects/chat-store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const EVIL = `<script>alert("x")</script>`;
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

function arch(): Architecture {
  return {
    version: 1,
    name: "bank",
    nodes: [
      { id: "web", type: "frontend", name: "Web app", path: "web" },
      { id: "api", type: "service", name: "API", path: "api" },
      { id: "api-routes", type: "module", name: "routes", path: "api/src/routes", parent: "api" },
      { id: "shared", type: "module", name: "shared", path: "shared" },
      { id: "ledger-db", type: "datastore", name: "Ledger DB" },
      { id: "events", type: "queue", name: "Events" },
      { id: "stripe", type: "external", name: "Stripe" },
      { id: "edge", type: "gateway", name: "Edge" },
    ],
    edges: [{ from: "web", to: "api" }, { from: "api", to: "ledger-db" }],
    workflows: [{ id: "request-path", name: "Request path", steps: ["web", "api", "ledger-db"] }],
  };
}

function product(): ProductFile {
  return {
    version: 1,
    personas: [
      { id: "retail", name: `Retail ${EVIL}`, description: "Pays bills from the phone" },
      { id: "biz", name: "Business owner" },
    ],
    screens: [
      { id: "home", name: "Home", route: "/home", path: "web/src/routes/home.tsx", node: "web", source: "scan", shot: ".ruah/shots/home.png" },
      { id: "transfer-new", name: "New transfer", route: "/transfer/new", node: "web" },
    ],
    journeys: [
      {
        id: "pay-rent",
        name: "Pay rent",
        persona: "retail",
        goal: "Pay my rent before the 1st",
        priority: "core",
        why: `Paying a known person is the most frequent action. ${EVIL}`,
        signal: "Median time to transfer sent < 30 s",
        steps: [
          {
            id: "check-balance",
            screen: "home",
            action: `Opens the app and reads the balance ${EVIL}`,
            sees: "Available balance, then the last 3 transactions",
            why: "Checking the balance is the #1 reason people open a bank app.",
            signal: "70 % open → balance",
            touches: ["web/src/routes/home.tsx#BalanceCard", "api/src/routes/accounts.ts#GET /accounts/:id/balance", "ledger-db"],
            evidence: [
              { quote: `I only open it to see if my salary landed. ${EVIL}`, source: "Interview — customer 4", date: "2026-09-10", kind: "past_behavior" },
              { quote: "I'd use a widget instead", source: "Survey", kind: "stated_preference", stance: "contradicts" },
            ],
          },
          { id: "start-transfer", screen: "home", action: "Taps Transfer, right below the balance", touches: ["gone-service"] },
          {
            id: "fill-and-send",
            screen: "transfer-new",
            action: "Picks the landlord, confirms, sends",
            question: `Should transfers under €50 skip the PIN? ${EVIL}`,
            touches: ["api", "events", "stripe", "request-path"],
            origin: "agent",
          },
        ],
        branches: [
          { from: "fill-and-send", when: "Insufficient funds", journey: "top-up", rejoin: "fill-and-send" },
          { from: "fill-and-send", when: "Edits the amount", to: "start-transfer" },
        ],
      },
      { id: "top-up", name: "Top up", persona: "retail", priority: "secondary", goal: "Add money", steps: [{ id: "add", action: "Adds money from a card", touches: ["stripe"] }] },
      { id: "invoice", name: "Send an invoice", persona: "biz", goal: "Get paid", priority: "core", steps: [{ id: "new", action: "Creates an invoice" }] },
    ],
  };
}

const WARNINGS = ["journey pay-rent: step start-transfer: broken link: gone-service"];

// ---- lanes ----------------------------------------------------------------------------

describe("laneOf", () => {
  it("places touches by element type, symbol name and owner", () => {
    const a = arch();
    expect(laneOf("web", a)).toBe("frontend");
    expect(laneOf("web/src/routes/home.tsx#BalanceCard", a)).toBe("frontend");
    expect(laneOf("api", a)).toBe("backend");
    expect(laneOf("edge", a)).toBe("backend");
    expect(laneOf("api-routes", a)).toBe("backend"); // a module inherits its parent's lane
    expect(laneOf("api/src/routes/accounts.ts", a)).toBe("backend");
    expect(laneOf("api/src/routes/accounts.ts#GET /accounts/:id/balance", a)).toBe("backend");
    expect(laneOf("web/src/api.ts#POST /login", a)).toBe("backend"); // a route symbol is backend wherever it sits
    expect(laneOf("api/src/hooks.ts#useBalance", a)).toBe("frontend"); // hooks are frontend
    expect(laneOf("shared", a)).toBe("frontend"); // module with no deciding ancestor
    expect(laneOf("ledger-db", a)).toBe("data");
    expect(laneOf("events", a)).toBe("data");
    expect(laneOf("stripe", a)).toBe("data");
    expect(laneOf("request-path", a)).toBe("backend"); // a workflow
  });

  it("falls back to the text of unresolved refs", () => {
    expect(laneOf("payments", null)).toBe("backend");
    expect(laneOf("orders-db", null)).toBe("data");
    expect(laneOf("web/src/Cart.tsx", null)).toBe("frontend");
    expect(laneOf("web/src/cart.ts#useCart", arch())).toBe("frontend");
    expect(describeTouch("nowhere/x.ts", arch())).toMatchObject({ kind: "unknown", name: "nowhere/x.ts", lane: "backend" });
  });

  it("describes expanded refs with their name, type and path", () => {
    expect(describeTouch("web/src/routes/home.tsx#BalanceCard", arch())).toMatchObject({ kind: "expanded", name: "BalanceCard", type: "symbol", path: "web/src/routes/home.tsx" });
    expect(describeTouch("api/src/routes/accounts.ts#GET /accounts/:id/balance", arch())).toMatchObject({ type: "route", path: "api/src/routes/accounts.ts" });
    expect(describeTouch("ledger-db", arch())).toMatchObject({ kind: "element", name: "Ledger DB", type: "datastore" });
    expect(LANES.map((l) => l.label)).toEqual(["Customer", "Screen", "Frontend", "Backend", "Data & external"]);
  });
});

// ---- storyboard -------------------------------------------------------------------------

describe("renderStoryboard", () => {
  const date = new Date("2026-09-27T12:00:00Z");

  it("escapes user text and renders every section of a journey", () => {
    const html = renderStoryboard(product(), arch(), "pay-rent", { screenshots: { home: PNG_URI }, warnings: WARNINGS, date });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // No external requests: no URLs, a CSP that forbids them, no scripts.
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("@media print");
    // Header: persona, goal, why, signal, priority.
    expect(html).toContain("<h1>Pay rent</h1>");
    expect(html).toContain("Retail &lt;script&gt;");
    expect(html).toContain("Pay my rent before the 1st");
    expect(html).toContain("Median time to transfer sent &lt; 30 s");
    expect(html).toContain('<span class="pill">core</span>');
    // Steps in order with numbers, screens and routes.
    const order = ["Opens the app", "Taps Transfer", "Picks the landlord"].map((s) => html.indexOf(s));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > (order[k - 1] ?? 0)))).toBe(true);
    expect(html).toContain('<div class="num" aria-hidden="true">3</div>');
    expect(html).toContain("Home <code>/home</code>");
    expect(html).toContain(`<img src="${PNG_URI}"`);
    expect(html).toContain("Why not written yet");
    expect(html).toContain("<dt>Sees</dt>");
    expect(html).toContain("70 % open → balance");
    // Evidence with source, date and strength; contradicting evidence flagged.
    expect(html).toContain("Interview — customer 4 · 2026-09-10 · ");
    expect(html).toContain('<span class="strength medium">Past behavior · strength 3/7</span>');
    expect(html).toContain('<span class="strength weak">Stated preference · strength 2/7</span>');
    expect(html).toContain("Contradicts the why");
    expect(html).toContain('<p class="question"><strong>Open question:</strong> Should transfers under €50 skip the PIN? &lt;script&gt;');
    // Code path collapsed, touches resolved, broken and unresolved ones raw.
    expect(html).toContain("<details><summary>Code path (3)</summary>");
    expect(html).toContain('<b>BalanceCard</b> <span class="type">symbol</span> <code>web/src/routes/home.tsx</code>');
    expect(html).toContain('<span class="lane data">Data &amp; external</span> <b>Ledger DB</b>');
    expect(html).toContain('<code>gone-service</code> <span class="broken">broken link</span>');
    expect(html).toContain('<b>Request path</b> <span class="type">workflow</span>');
    // Branches after the step they leave from.
    expect(html).toContain('When <b>Insufficient funds</b> → Top up, back at step 3');
    expect(html).toMatch(/When <b>Edits the amount<\/b> → <a href="#j--pay-rent--start-transfer">back to step 2 \(Taps Transfer/);
    expect(html.indexOf("Insufficient funds")).toBeGreaterThan(html.indexOf("Picks the landlord"));
    expect(html).toContain("Made with Ruah · 2026-09-27");
  });

  it("marks touches unresolved without a map and ignores anything but image data URIs", () => {
    const html = renderStoryboard(product(), null, "pay-rent", { screenshots: { home: "javascript:alert(1)" }, date });
    expect(html).not.toContain("<img");
    expect(html).toContain('<code>ledger-db</code> <span class="broken">unresolved</span>');
    expect(() => renderStoryboard(product(), null, "nope")).toThrow('unknown journey "nope"');
    // By name too.
    expect(renderStoryboard(product(), null, "Top up", { date })).toContain("<h1>Top up</h1>");
  });

  it("puts every journey in one page behind an index grouped by persona", () => {
    const html = renderAllStoryboards(product(), arch(), { title: "Bank — journeys", date });
    expect(renderStoryboard(product(), arch(), undefined, { title: "Bank — journeys", date })).toBe(html);
    expect(html).toContain("<h1>Bank — journeys</h1>");
    expect(html).toContain('<nav class="index" aria-label="Journeys"><h2>Retail &lt;script&gt;');
    expect(html).toContain('<a href="#j--pay-rent">Pay rent</a>');
    expect(html).toContain("<h2>Business owner</h2>");
    for (const id of ["pay-rent", "top-up", "invoice"]) expect(html).toContain(`<section class="journey" id="j--${id}">`);
    // Branch into another journey links to its section; the target says where it comes from.
    expect(html).toContain('<a href="#j--top-up">Top up, back at step 3</a>');
    expect(html).toContain('Also reached from: <a href="#j--pay-rent">Pay rent</a> (step 3, when Insufficient funds)');
    expect(html.indexOf('id="j--pay-rent"')).toBeLessThan(html.indexOf('id="j--top-up"')); // core first
  });
});

// ---- markdown -----------------------------------------------------------------------------

describe("journeyMarkdown", () => {
  it("renders a PR-ready block", () => {
    const md = journeyMarkdown(product(), arch(), "pay-rent", { warnings: WARNINGS });
    expect(md).toContain("## Journey: Pay rent\n");
    expect(md).toContain("**Persona:** Retail \\<script\\>alert(\"x\")\\</script\\> · **Priority:** core · **Steps:** 3");
    expect(md).toContain("**Goal:** Pay my rent before the 1st");
    expect(md).toContain("**Signal:** Median time to transfer sent \\< 30 s");
    expect(md).toContain("1. **Opens the app and reads the balance \\<script\\>");
    expect(md).toContain("— Home (`/home`)");
    expect(md).toContain("   - Why: Checking the balance is the #1 reason people open a bank app.");
    expect(md).toContain("2. **Taps Transfer, right below the balance** — Home (`/home`)\n   - Why: _not written yet_");
    expect(md).toContain("`web/src/routes/home.tsx#BalanceCard` (BalanceCard, frontend)");
    expect(md).toContain("`ledger-db` (Ledger DB, data & external)");
    expect(md).toContain("`gone-service` (broken link)");
    expect(md).toContain("     > “I only open it to see if my salary landed. \\<script\\>");
    expect(md).toContain("     > — Interview — customer 4, 2026-09-10 (Past behavior · strength 3/7)");
    expect(md).toContain("(Stated preference · strength 2/7, contradicts the why)");
    expect(md).toContain("   - **Open question:** Should transfers under €50 skip the PIN?");
    expect(md).toContain("### Branches\n\n- From step 3 when **Insufficient funds** → Top up, back at step 3\n- From step 3 when **Edits the amount** → back to step 2 (Taps Transfer, right below the balance)");
    expect(md).not.toMatch(/(^|[^\\])<script/);
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toContain("\n\n\n");
  });

  it("lists every journey by persona without an id", () => {
    const md = journeyMarkdown(product(), null);
    expect(md.startsWith("# Customer journeys\n")).toBe(true);
    expect(md).toContain("- **Business owner:** Send an invoice (core)");
    expect(md.match(/^## Journey: /gm)).toHaveLength(3);
    expect(md).toContain("`ledger-db` (unresolved)");
  });
});

// ---- draw.io --------------------------------------------------------------------------------

/** Minimal well-formedness check: balanced tags, quoted attributes, known entities, no raw '<' in values. */
function checkXml(xml: string): { diagrams: string[] } {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  const diagrams: string[] = [];
  const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>/y;
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    const text = lt === -1 ? body.slice(i) : body.slice(i, lt);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) throw new Error(`bad entity in text: ${text.slice(0, 40)}`);
    if (lt === -1) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(body);
    if (m === null) throw new Error(`malformed tag at ${lt}: ${body.slice(lt, lt + 60)}`);
    const [, close, name = "", attrs = "", selfClose] = m;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(attrs)) throw new Error(`bad entity in attributes of <${name}>`);
    const names = [...attrs.matchAll(/\s([A-Za-z_][\w.:-]*)="/g)].map((a) => a[1]);
    if (new Set(names).size !== names.length) throw new Error(`duplicate attribute in <${name}>`);
    if (close === "/") {
      if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
    } else if (selfClose !== "/") stack.push(name);
    if (name === "diagram" && close !== "/") diagrams.push(/\sname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    i = TAG.lastIndex;
  }
  if (stack.length !== 0) throw new Error(`unclosed <${stack.at(-1)}>`);
  return { diagrams };
}

describe("draw.io journey pages", () => {
  it("adds one swimlane page per journey only when a product is passed", () => {
    const a = arch();
    const plain = toDrawio(a);
    expect(toDrawio(a, { product: null })).toBe(plain);
    expect(checkXml(plain).diagrams.some((d) => d.startsWith("Journey:"))).toBe(false);
    const xml = toDrawio(a, { product: product(), productWarnings: WARNINGS });
    const { diagrams } = checkXml(xml);
    expect(diagrams.filter((d) => d.startsWith("Journey:"))).toEqual(["Journey: Pay rent", "Journey: Top up", "Journey: Send an invoice"]);
    expect(diagrams.at(-1)).toBe("Specifications");
  });

  it("journeysToDrawio: lanes, steps, touches in their lanes, arrows and branches", () => {
    const xml = journeysToDrawio(product(), arch(), { warnings: WARNINGS, agent: "ruah test" });
    const { diagrams } = checkXml(xml);
    expect(diagrams).toEqual(["Journey: Pay rent", "Journey: Top up", "Journey: Send an invoice"]);
    for (const label of ["Customer", "Screen", "Frontend", "Backend", "Data &amp;amp; external"]) expect(xml).toContain(`label="${label}"`);
    expect(xml).toContain('ruahLane="data"');
    // The ledger touch sits in the data lane, the route in the backend lane.
    expect(xml).toMatch(/ruahId="ledger-db"[^>]*>\s*<mxCell style="[^"]*" vertex="1" parent="lane-data"/);
    expect(xml).toMatch(/ruahId="api\/src\/routes\/accounts.ts#GET \/accounts\/:id\/balance"[^>]*>\s*<mxCell style="[^"]*" vertex="1" parent="lane-backend"/);
    expect(xml).toMatch(/ruahId="web\/src\/routes\/home.tsx#BalanceCard"[^>]*>\s*<mxCell style="[^"]*" vertex="1" parent="lane-frontend"/);
    expect(xml).toContain('status="broken"');
    // Consecutive steps joined; branches dashed and labelled with `when`.
    expect(xml).toMatch(/id="flow-1"[^>]*source="step-0" target="step-1"/);
    expect(xml).toMatch(/id="branch-0-in" value="Insufficient funds"[^>]*dashed=1/);
    expect(xml).toContain('label="Edits the amount"');
    expect(xml).toContain("link=\"data:page/id,journey-top-up\"");
    expect(xml).not.toContain("<script");
    // One journey only; unknown ids throw.
    expect(checkXml(journeysToDrawio(product(), null, { journeyId: "top-up" })).diagrams).toEqual(["Journey: Top up"]);
    expect(() => journeysToDrawio(product(), null, { journeyId: "nope" })).toThrow("unknown journey");
  });
});

// ---- disk: screenshots, CLI, export drawio -----------------------------------------------------

function repo(opts: { product?: unknown; shot?: boolean } = {}): string {
  const root = tempDir("ruah-journeys-");
  writeFileSync(path.join(root, "architecture.json"), JSON.stringify(arch()));
  mkdirSync(path.join(root, "web", "src", "routes"), { recursive: true });
  writeFileSync(path.join(root, "web", "src", "routes", "home.tsx"), "export function BalanceCard() { return null; }\n");
  if (opts.product !== undefined) writeFileSync(path.join(root, "product.json"), JSON.stringify(opts.product));
  if (opts.shot === true) {
    mkdirSync(path.join(root, ".ruah", "shots"), { recursive: true });
    writeFileSync(path.join(root, ".ruah", "shots", "home.png"), PNG);
  }
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk);
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe("screenshots from disk", () => {
  it("embeds shots inside the project and refuses paths outside it", () => {
    const root = repo({ shot: true });
    const p = product();
    expect(loadScreenshots(root, p)).toEqual({ home: PNG_URI });
    const outside = tempDir("ruah-outside-");
    writeFileSync(path.join(outside, "x.png"), PNG);
    p.screens[0]!.shot = path.relative(root, path.join(outside, "x.png"));
    p.screens[1]!.shot = "/etc/passwd.png";
    rmSync(path.join(root, ".ruah"), { recursive: true });
    expect(loadScreenshots(root, p)).toEqual({});
  });
});

describe("ruah app journeys", () => {
  it("list: persona, priority, steps and gaps (missing why, questions, broken links)", async () => {
    const root = repo({ product: product() });
    const loaded = await loadProduct(root);
    expect(loaded.errors).toEqual([]);
    // gone-service is not in the map: a broken link; the expanded file resolves.
    expect(loaded.warnings).toContain("journey pay-rent: step start-transfer: broken link: gone-service");
    expect(loaded.warnings.some((w) => w.includes("BalanceCard"))).toBe(false);
    expect(journeyGaps(loaded.product!.journeys[0]!, loaded.warnings)).toEqual({ missingWhy: 2, openQuestions: 1, brokenLinks: 2 });

    const text = await capture(() => runJourneys(["--root", root, "list"], "0.0.0-test"));
    expect(text.code).toBe(0);
    expect(text.out).toContain("3 journeys in");
    expect(text.out).toMatch(/pay-rent\s+Pay rent · Retail <script>alert\("x"\)<\/script> · core · 3 steps · 2 missing whys, 1 open question, 2 broken links/);
    expect(text.out).toMatch(/top-up\s+Top up · .* · secondary · 1 step · no gaps/);
    expect(text.out).toMatch(/invoice\s+Send an invoice · Business owner · core · 1 step · 2 missing whys/);

    const json = await capture(() => runJourneys(["--root", root, "--json"], "0.0.0-test"));
    const parsed = JSON.parse(json.out) as { journeys: { id: string; gaps: unknown }[] };
    expect(parsed.journeys.map((j) => j.id)).toEqual(["pay-rent", "top-up", "invoice"]);
  });

  it("show and export (html, md, drawio, --all, stdout); errors and exit codes", async () => {
    const root = repo({ product: product(), shot: true });
    const show = await capture(() => runJourneys(["show", "pay-rent", "--root", root], "0.0.0-test"));
    expect(show.code).toBe(0);
    expect(show.out).toContain("pay-rent · Pay rent");
    expect(show.out).toContain("broken link: gone-service");
    expect(show.out).not.toContain("personas (");

    const out = tempDir("ruah-journeys-out-");
    const html = await capture(() => runJourneys(["export", "pay-rent", "--root", root, "--out", path.join(out, "s.html")], "0.0.0-test"));
    expect(html.code).toBe(0);
    expect(html.err).toContain("wrote");
    const page = readFileSync(path.join(out, "s.html"), "utf8");
    expect(page).toContain(`<img src="${PNG_URI}"`);
    expect(page).toContain('<code>gone-service</code> <span class="broken">broken link</span>');
    const noShots = await capture(() => runJourneys(["export", "pay-rent", "--root", root, "--no-shots", "--out", "-"], "0.0.0-test"));
    expect(noShots.out).not.toContain("<img");

    const md = await capture(() => runJourneys(["export", "pay-rent", "--md", "--root", root, "--out", "-"], "0.0.0-test"));
    expect(md.out.startsWith("## Journey: Pay rent")).toBe(true);
    const drawio = await capture(() => runJourneys(["export", "--all", "--format", "drawio", "--root", root, "--out", path.join(out, "j.drawio")], "0.0.0-test"));
    expect(drawio.code).toBe(0);
    expect(checkXml(readFileSync(path.join(out, "j.drawio"), "utf8")).diagrams).toHaveLength(3);
    const all = await capture(() => runJourneys(["export", "--all", "--root", root, "--out", "-"], "0.0.0-test"));
    expect(all.out).toContain("<h1>bank — customer journeys</h1>");

    expect((await capture(() => runJourneys(["show", "nope", "--root", root], "t"))).code).toBe(2);
    expect((await capture(() => runJourneys(["export", "--root", root], "t"))).code).toBe(2);
    expect((await capture(() => runJourneys(["export", "pay-rent", "--format", "pdf", "--root", root], "t"))).code).toBe(2);
    expect((await capture(() => runJourneys(["frobnicate", "--root", root], "t"))).code).toBe(2);
    expect((await capture(() => runJourneys(["--bogus"], "t"))).code).toBe(2);
    const help = await capture(() => runJourneys(["--help"], "t"));
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: ruah app journeys");

    const empty = repo();
    const none = await capture(() => runJourneys(["--root", empty], "t"));
    expect(none.code).toBe(0);
    expect(none.out).toContain("No journeys yet");
    expect((await capture(() => runJourneys(["show", "x", "--root", empty], "t"))).code).toBe(1);
    const broken = repo({ product: { version: 1, personas: [], screens: [], journeys: [{ id: "x", name: "x", goal: "g", steps: [] }] } });
    const invalid = await capture(() => runJourneys(["--root", broken], "t"));
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("is invalid");
  });

  it("built binary: help lists the command and `journeys --help` prints its own usage", () => {
    const cli = path.resolve("dist/cli.js");
    const env = { ...process.env, RUAH_HOME: tempDir("ruah-home-") };
    expect(execFileSync(process.execPath, [cli, "help"], { encoding: "utf8", env })).toContain("ruah app journeys [--root <dir>]");
    expect(execFileSync(process.execPath, [cli, "journeys", "--help"], { encoding: "utf8", env })).toContain("usage: ruah app journeys");
    const root = repo({ product: product() });
    const md = execFileSync(process.execPath, [cli, "journeys", "--root", root, "export", "top-up", "--format", "md", "--out", "-"], { encoding: "utf8", env });
    expect(md).toContain("## Journey: Top up");
  });

  it("`ruah app export drawio` adds the journey pages when the repo has a product.json", async () => {
    const root = repo({ product: product() });
    const out = path.join(tempDir("ruah-out-"), "a.drawio");
    const previous = process.env.RUAH_HOME;
    process.env.RUAH_HOME = tempDir("ruah-home-");
    cleanups.push(() => {
      if (previous === undefined) delete process.env.RUAH_HOME;
      else process.env.RUAH_HOME = previous;
    });
    const res = await capture(() => runExport(["drawio", root, "--out", out], "0.0.0-test"));
    expect(res.code).toBe(0);
    expect(res.err).toContain("3 journeys");
    expect(checkXml(readFileSync(out, "utf8")).diagrams.filter((d) => d.startsWith("Journey:"))).toHaveLength(3);
  });
});

describe("exportJourneys", () => {
  it("names files and sets content types", () => {
    const base = { product: product(), architecture: arch() };
    expect(exportJourneys("html", { ...base, journeyId: "pay-rent" })).toMatchObject({ fileName: "pay-rent.storyboard.html", contentType: "text/html; charset=utf-8" });
    expect(exportJourneys("md", { ...base, projectName: "Bank app" })).toMatchObject({ fileName: "Bank-app-journeys.md", contentType: "text/markdown; charset=utf-8" });
    expect(exportJourneys("drawio", { ...base, journeyId: "Top up" }).fileName).toBe("top-up.drawio");
  });
});

// ---- HTTP -------------------------------------------------------------------------------------

async function serve(withProduct: boolean | "none"): Promise<string> {
  const home = tempDir("ruah-home-");
  let hub: SessionHub;
  if (withProduct === "none") {
    hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", chats: new ChatStore(home) });
  } else {
    const root = repo({ ...(withProduct ? { product: product() } : {}), shot: true });
    const store = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
    await store.load();
    const productStore = createProductStore(path.join(root, "product.json"), { watch: false, touchResolver: () => touchResolverFor(store) });
    await productStore.load();
    hub = new SessionHub(store, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", chats: new ChatStore(home) });
    hub.setProject({ info: projectInfoForStore(store), store, product: productStore });
  }
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {} });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  return server.url;
}

describe("GET /api/product/export", () => {
  it("answers 409 without an open project and 404 without a product.json", async () => {
    const none = await serve("none");
    expect((await fetch(`${none}/api/product/export`)).status).toBe(409);
    const empty = await serve(false);
    const res = await fetch(`${empty}/api/product/export`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("no product.json");
  });

  it("downloads a storyboard, markdown or draw.io as an attachment", async () => {
    const url = await serve(true);
    const html = await fetch(`${url}/api/product/export?format=html&journey=pay-rent`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-disposition")).toBe('attachment; filename="pay-rent.storyboard.html"');
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await html.text();
    expect(page).toContain("<h1>Pay rent</h1>");
    expect(page).toContain(`<img src="${PNG_URI}"`);
    expect(page).toContain('<code>gone-service</code> <span class="broken">broken link</span>');
    expect(await (await fetch(`${url}/api/product/export?journey=pay-rent&shots=0`)).text()).not.toContain("<img");

    const all = await fetch(`${url}/api/product/export?format=md`);
    expect(all.headers.get("content-disposition")).toBe('attachment; filename="bank-journeys.md"');
    expect((await all.text()).match(/^## Journey: /gm)).toHaveLength(3);

    const drawio = await fetch(`${url}/api/product/export?format=drawio&journey=top-up`);
    expect(drawio.headers.get("content-type")).toBe("application/vnd.jgraph.mxfile; charset=utf-8");
    expect(checkXml(await drawio.text()).diagrams).toEqual(["Journey: Top up"]);

    expect((await fetch(`${url}/api/product/export?format=pdf`)).status).toBe(400);
    expect((await fetch(`${url}/api/product/export?journey=nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/product/export`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${url}/api/product/export?format=md`, { method: "HEAD" })).status).toBe(200);

    // The architecture export carries the journey pages too.
    const arch = await fetch(`${url}/api/export/drawio`);
    expect(checkXml(await arch.text()).diagrams.filter((d) => d.startsWith("Journey:"))).toHaveLength(3);
  });
});
