// ui/test/preview.test.ts — the live preview's viewer helpers (CONTRACTS §15): the fix request
// drafted for the agent, URL-bar navigation, device scaling, candidate grouping, state labels.
import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  candidateLabel,
  effectiveAutoReload,
  fitScale,
  groupCandidates,
  resolveNavigation,
  stateMeta,
  type PreviewCandidate,
  type PreviewStatus,
} from "@/lib/preview";

const candidate = (over: Partial<PreviewCandidate> = {}): PreviewCandidate => ({
  id: "apps/web#dev",
  title: "Vite",
  command: "pnpm run dev",
  dir: "apps/web",
  framework: "vite",
  kind: "script",
  hmr: true,
  reason: "package.json scripts.dev",
  score: 13,
  workspace: "@acme/web",
  ...over,
});

const status = (over: Partial<PreviewStatus> = {}): PreviewStatus => ({
  projectId: "p1",
  root: "/r",
  rev: 1,
  state: "crashed",
  candidate: candidate(),
  command: "pnpm run dev",
  cwd: "/r/apps/web",
  url: null,
  port: null,
  healthy: false,
  framing: "unknown",
  hmr: true,
  runner: "pty",
  terminalId: "t_1",
  pid: null,
  startedAt: "2026-09-25T10:00:00.000Z",
  exitCode: 1,
  signal: null,
  error: "The dev server exited with code 1: Error: Cannot find module 'vite'",
  logs: ["> dev", "> vite", "Error: Cannot find module 'vite'"],
  ...over,
});

describe("Ask agent to fix", () => {
  it("drafts the command, folder, exit and the last output", () => {
    const text = buildFixPrompt(status());
    expect(text).toContain("`pnpm run dev` (in apps/web). It exited with code 1.");
    expect(text).toContain("Error: The dev server exited with code 1");
    expect(text).toContain("```\n> dev\n> vite\nError: Cannot find module 'vite'\n```");
    expect(text).toMatch(/fix it so the dev server starts again/);
  });

  it("keeps the prompt bounded", () => {
    const logs = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(400)}`);
    const text = buildFixPrompt(status({ logs }), logs);
    expect(text).not.toContain("line 439 ");
    expect(text).toContain("line 499 ");
    expect(text.length).toBeLessThan(60 * 310 + 1000);
  });

  it("says signal when there is no exit code", () => {
    expect(buildFixPrompt(status({ exitCode: null, signal: 9, candidate: candidate({ dir: "." }) }))).toContain("`pnpm run dev`. It was stopped by signal 9.");
  });
});

describe("URL bar", () => {
  const base = "http://localhost:5173/";
  it("paths stay on the dev server", () => {
    expect(resolveNavigation(base, "/about")).toBe("http://localhost:5173/about");
    expect(resolveNavigation(base, "settings?tab=1")).toBe("http://localhost:5173/settings?tab=1");
    expect(resolveNavigation(base, "")).toBe(base);
  });
  it("full and host:port addresses are accepted", () => {
    expect(resolveNavigation(base, "http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(resolveNavigation(base, "localhost:8080/admin")).toBe("http://localhost:8080/admin");
    expect(resolveNavigation(null, "/about")).toBeNull();
    expect(resolveNavigation(base, "http://[bad")).toBeNull();
  });
});

describe("helpers", () => {
  it("auto-reload defaults to on without HMR", () => {
    expect(effectiveAutoReload(undefined, false)).toBe(true);
    expect(effectiveAutoReload(undefined, true)).toBe(false);
    expect(effectiveAutoReload(false, false)).toBe(false);
    expect(effectiveAutoReload(true, true)).toBe(true);
  });

  it("device widths scale down to fit, never up", () => {
    expect(fitScale(1200, null)).toBe(1);
    expect(fitScale(1200, 390)).toBe(1);
    expect(fitScale(442, 820)).toBeCloseTo(0.5, 5);
    expect(fitScale(0, 820)).toBe(1);
  });

  it("groups candidates per app folder, the saved command apart", () => {
    const groups = groupCandidates([
      candidate({ id: "custom", kind: "custom", dir: "." }),
      candidate(),
      candidate({ id: "apps/web#storybook", title: "Storybook" }),
      candidate({ id: ".#dev", dir: ".", workspace: undefined }),
    ]);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Saved command", 1],
      ["apps/web · @acme/web", 2],
      ["Project root", 1],
    ]);
  });

  it("state labels and picker labels", () => {
    expect(stateMeta(null)).toEqual({ label: "Stopped", tone: "muted" });
    expect(stateMeta(status({ state: "running", healthy: true }))).toEqual({ label: "Running", tone: "ok" });
    expect(stateMeta(status({ state: "running", healthy: false })).tone).toBe("warn");
    expect(stateMeta(status({ state: "starting" })).tone).toBe("warn");
    expect(stateMeta(status()).tone).toBe("bad");
    expect(candidateLabel(candidate())).toBe("Vite · apps/web");
    expect(candidateLabel(candidate({ dir: "." }))).toBe("Vite");
    expect(candidateLabel(null)).toBe("Choose what to run");
  });
});
