// ui/test/view-restore.test.ts — the shell's per-project view state (ui/src/lib/view-restore.ts):
// round trip through the stored JSON, validation of what comes back, the 16 KB rule, page restore.
import { describe, expect, it } from "vitest";
import type { ViewState } from "@/lib/contracts";
import {
  DEFAULT_SHELL_VIEW,
  PANEL_MAX,
  PANEL_MIN,
  decodeShellView,
  encodeShellView,
  pageOf,
  projectPageToStore,
  restorePage,
  sameShellView,
  type ShellView,
} from "@/lib/view-restore";

const view: ShellView = {
  page: "/cloud",
  diagramId: "arch:api.payments",
  camera: { x: 120.44, y: -35.06, k: 1.23456 },
  drawerOpen: true,
  panelOpen: false,
  panelView: "code",
  panelWidth: 512,
};

describe("view state round trip", () => {
  it("decodes what it encodes (camera rounded)", () => {
    const stored = JSON.parse(JSON.stringify(encodeShellView(view))) as ViewState;
    expect(decodeShellView(stored)).toEqual({ ...view, camera: { x: 120.4, y: -35.1, k: 1.235 } });
  });

  it("keeps a framed camera's mark, and only then (views saved before it read as the user's own)", () => {
    const framed = { ...view, camera: { x: 10, y: 20, k: 0.5, framed: true as const } };
    const back = decodeShellView(JSON.parse(JSON.stringify(encodeShellView(framed))) as ViewState);
    expect(back?.camera).toEqual({ x: 10, y: 20, k: 0.5, framed: true });
    expect(decodeShellView(encodeShellView(view))?.camera?.framed).toBeUndefined();
    expect(decodeShellView({ shell: { v: 1, camera: { x: 1, y: 2, k: 1, framed: "yes" } } })?.camera).toEqual({ x: 1, y: 2, k: 1 });
    expect(sameShellView(framed, { ...framed, camera: { x: 10, y: 20, k: 0.5 } })).toBe(false);
  });

  it("keeps other writers' keys", () => {
    const stored = encodeShellView(view, { other: { a: 1 } });
    expect(stored.other).toEqual({ a: 1 });
    expect(decodeShellView(stored)?.page).toBe("/cloud");
  });

  it("stays far below the 16 KB limit", () => {
    const big = { ...view, diagramId: "x".repeat(512) };
    expect(new TextEncoder().encode(JSON.stringify(encodeShellView(big))).length).toBeLessThan(2048);
  });

  it("treats equal views as the same (no redundant save)", () => {
    expect(sameShellView(view, { ...view, camera: { x: 120.41, y: -35.1, k: 1.2346 } })).toBe(true);
    expect(sameShellView(view, { ...view, drawerOpen: false })).toBe(false);
    expect(sameShellView(null, null)).toBe(true);
    expect(sameShellView(view, null)).toBe(false);
  });
});

describe("decodeShellView", () => {
  it("returns null without a shell view", () => {
    expect(decodeShellView(null)).toBeNull();
    expect(decodeShellView({})).toBeNull();
    expect(decodeShellView({ shell: [] })).toBeNull();
    expect(decodeShellView({ shell: { v: 2 } })).toBeNull();
  });

  it("falls back per field on bad values", () => {
    const decoded = decodeShellView({
      shell: { v: 1, page: "/nope", diagramId: 42, camera: { x: 1, y: 2, k: -1 }, panelOpen: "yes", panelView: "x", panelWidth: 9999 },
    });
    expect(decoded).toEqual({
      ...DEFAULT_SHELL_VIEW,
      page: DEFAULT_SHELL_VIEW.page,
      diagramId: null,
      camera: null,
      panelOpen: true,
      panelView: "agent",
      panelWidth: PANEL_MAX,
    });
  });

  it("clamps the panel width", () => {
    expect(decodeShellView(encodeShellView({ ...view, panelWidth: 10 }))?.panelWidth).toBe(PANEL_MIN);
  });
});

describe("restorePage", () => {
  const saved = decodeShellView(encodeShellView(view));
  it("opens the saved page when entering a project", () => {
    expect(restorePage(saved, "/map", false)).toBe("/cloud");
  });
  it("keeps the page the user asked for (first load: the URL; a switch that opens a chat)", () => {
    expect(restorePage(saved, "/map", true)).toBeNull();
  });
  it("does nothing when already there or when nothing is saved", () => {
    expect(restorePage(saved, "/cloud", false)).toBeNull();
    expect(restorePage(null, "/map", false)).toBeNull();
  });
  // Regression: Home, Settings, Usage, Integrations and Chats were stored as the project's page,
  // so switching back to a project landed on the global Home (looked like nothing happened).
  it("never restores an app-wide page: an older view holding one opens the map", () => {
    for (const page of ["/", "/settings", "/usage", "/integrations", "/chats"] as const) {
      expect(restorePage({ ...view, page }, "/", false), page).toBe("/map");
    }
    expect(restorePage({ ...view, page: "/settings" }, "/map", false)).toBeNull();
    expect(restorePage({ ...view, page: "/?view=project" }, "/", false)).toBe("/?view=project");
    expect(restorePage({ ...view, page: "/?view=project" }, pageOf("/", { view: "project" }), false)).toBeNull();
  });
});

describe("projectPageToStore", () => {
  it("stores the current page only when it is a project page", () => {
    const prev = { ...view, page: "/cloud" as const };
    expect(projectPageToStore("/agent", prev)).toBe("/agent");
    expect(projectPageToStore(pageOf("/", { view: "project" }), prev)).toBe("/?view=project");
    // On Home / Settings / Chats the project keeps the project page it had.
    for (const global of ["/", "/settings", "/usage", "/integrations", "/chats", "/extensions"]) {
      expect(projectPageToStore(global, prev), global).toBe("/cloud");
    }
    expect(projectPageToStore("/settings", null)).toBe("/map");
    expect(projectPageToStore("/settings", { ...view, page: "/" })).toBe("/map");
  });
});
