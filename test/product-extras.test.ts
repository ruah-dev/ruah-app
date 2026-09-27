// test/product-extras.test.ts — the rest of the product side (CONTRACTS §23.8–23.9): screenshots
// (POST / GET /api/product/shot and their confinement), drift (reviewed journeys whose code changed
// since, from git), the Home card summary, and screen paths of multi-repo systems.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import { validateProduct, type ProductFile } from "../src/contracts/product.js";
import { createProductStore, type ProductStore } from "../src/serve/product-store.js";
import { handleProductShotRequest, resolveShot } from "../src/serve/product-shots-http.js";
import { journeyPaths, productDrift } from "../src/product/drift.js";
import { productSummary } from "../src/product/summary.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-product-extras-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ARCH: Architecture = {
  version: 1,
  name: "bank",
  nodes: [
    { id: "web", type: "frontend", name: "web", path: "web" },
    { id: "api", type: "service", name: "api", path: "api" },
  ],
  edges: [],
  workflows: [],
};

const PRODUCT: ProductFile = {
  version: 1,
  personas: [],
  screens: [{ id: "home", name: "Home", route: "/home", path: "web/src/home.tsx" }],
  journeys: [
    {
      id: "pay-rent",
      name: "Pay rent",
      goal: "Pay",
      priority: "core",
      steps: [
        { id: "a", screen: "home", action: "Reads the balance", touches: ["api/src/balance.ts#getBalance"], question: "Hide the balance?" },
        { id: "b", action: "Sends", touches: ["gone"] },
      ],
    },
  ],
};

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("screenshots", () => {
  async function serve(store: ProductStore | null): Promise<{ url: string }> {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleProductShotRequest(req, res, url, { product: store }, (origin) => origin === undefined || origin === "http://127.0.0.1:4177")) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const a = server.address();
    return { url: `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}` };
  }

  it("stores a capture under .ruah/shots, sets the screen's shot, and serves it back", async () => {
    const root = tmp();
    writeFileSync(join(root, "product.json"), JSON.stringify(PRODUCT));
    const store = createProductStore(join(root, "product.json"), { watch: false });
    await store.load();
    const { url } = await serve(store);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/product/shot`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    expect((await post({ screen: "home", image: PNG_1PX }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ screen: "home", image: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
    expect((await post({ screen: "nope", image: PNG_1PX })).status).toBe(404);

    const ok = await post({ screen: "home", image: PNG_1PX });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, shot: ".ruah/shots/home.png" });
    expect(store.current()?.screens[0]?.shot).toBe(".ruah/shots/home.png");
    expect(readFileSync(join(root, ".ruah/shots/home.png")).subarray(1, 4).toString()).toBe("PNG");

    const img = await fetch(`${url}/api/product/shot?path=${encodeURIComponent(".ruah/shots/home.png")}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${url}/api/product/shot?path=product.json`)).status).toBe(404);
    expect((await fetch(`${url}/api/product/shot?path=${encodeURIComponent(".ruah/shots/home.png")}`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    store.close();
  });

  it("resolveShot keeps to the shot folders and image files, symlinks included", () => {
    const root = tmp();
    mkdirSync(join(root, ".ruah/shots"), { recursive: true });
    writeFileSync(join(root, ".ruah/shots/a.jpg"), "x");
    writeFileSync(join(root, "secret.png"), "x");
    symlinkSync(join(root, "secret.png"), join(root, ".ruah/shots/link.png"));
    expect(resolveShot(root, ".ruah/shots/a.jpg")).not.toBeNull();
    expect(resolveShot(root, ".ruah/shots/../../secret.png")).toBeNull();
    expect(resolveShot(root, ".ruah/shots/link.png")).toBeNull();
    expect(resolveShot(root, "secret.png")).toBeNull();
    expect(resolveShot(root, ".ruah/shots/a.txt")).toBeNull();
  });
});

describe("drift", () => {
  const g = (root: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" }).toString();
  const gAt = (root: string, date: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    }).toString();

  it("maps a journey to the paths behind it", () => {
    expect(journeyPaths(PRODUCT, "pay-rent", ARCH)).toEqual(["web/src/home.tsx", "api/src/balance.ts"]);
  });

  it("finds reviewed journeys whose code changed since the review, committed or not", async () => {
    const root = tmp();
    mkdirSync(join(root, "web/src"), { recursive: true });
    mkdirSync(join(root, "api/src"), { recursive: true });
    writeFileSync(join(root, "web/src/home.tsx"), "export const Home = 1;\n");
    writeFileSync(join(root, "api/src/balance.ts"), "export const getBalance = 1;\n");
    g(root, "init", "-q", "-b", "main");
    g(root, "add", ".");
    gAt(root, "2026-01-01T00:00:00Z", "commit", "-q", "-m", "init");
    const reviewed: ProductFile = structuredClone(PRODUCT);
    reviewed.journeys[0]!.reviewedAt = "2026-02-01T00:00:00.000Z";
    expect(await productDrift(reviewed, ARCH, { root })).toEqual([]);

    writeFileSync(join(root, "api/src/balance.ts"), "export const getBalance = 2;\n");
    const dirty = await productDrift(reviewed, ARCH, { root });
    expect(dirty).toMatchObject([{ journey: "pay-rent", commit: null, uncommitted: 1 }]);

    g(root, "commit", "-q", "-am", "Show pending transfers in the balance");
    const committed = await productDrift(reviewed, ARCH, { root });
    expect(committed[0]?.commit?.subject).toBe("Show pending transfers in the balance");
    expect(committed[0]?.uncommitted).toBe(0);

    // Never reviewed: not drift (the health panel says "not reviewed" instead).
    expect(await productDrift(PRODUCT, ARCH, { root })).toEqual([]);
  });
});

describe("Home summary and system screen paths", () => {
  it("counts journeys, questions and gaps; null without a product", () => {
    const root = tmp();
    expect(productSummary(root)).toBeNull();
    writeFileSync(join(root, "architecture.json"), JSON.stringify(ARCH));
    writeFileSync(join(root, "product.json"), JSON.stringify(PRODUCT));
    // gaps: question 1 + broken "gone" 1 + 2 steps without why + journey without why, signal, evidence 3
    expect(productSummary(root)).toEqual({ journeys: 1, questions: 1, gaps: 7, broken: 1 });
  });

  it("checks screen paths through the system's resolver", async () => {
    const root = tmp();
    const product: ProductFile = { version: 1, personas: [], journeys: [], screens: [{ id: "web:home", name: "Home", path: "web/src/home.tsx" }] };
    expect(validateProduct(product, { root }).ok && validateProduct(product, { root })).toMatchObject({ warnings: ["screen web:home: path does not exist on disk: web/src/home.tsx"] });
    const ok = validateProduct(product, { root, pathExists: (rel) => rel === "web/src/home.tsx" });
    expect(ok).toMatchObject({ ok: true, warnings: [] });
    writeFileSync(join(root, "product.json"), JSON.stringify(product));
    const store = createProductStore(join(root, "product.json"), { watch: false, pathExists: () => true });
    await store.load();
    expect(store.warnings()).toEqual([]);
    store.close();
  });
});
