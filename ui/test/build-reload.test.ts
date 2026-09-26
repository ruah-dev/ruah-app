// ui/test/build-reload.test.ts — auto-reload onto a newer viewer build (ui/src/lib/build-reload.ts):
// when a window reloads by itself, when it only offers a "Reload" toast, the one-reload guard
// that prevents loops, and what counts as "busy" (typed text, open dialogs).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_ID,
  busyReasons,
  hasComposerPending,
  hasOpenOverlay,
  hasUnsavedInput,
  markReloadResume,
  reloadAttempted,
  reloadDecision,
  reloadForBuild,
  setComposerPending,
  takeBuildReloadResume,
  type ReloadInputs,
} from "@/lib/build-reload";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const base: ReloadInputs = { own: "b1", served: "b2", sameOrigin: true, busy: false, attempted: null };

describe("reloadDecision", () => {
  it("does nothing without two ids to compare, on another origin, or when up to date", () => {
    expect(reloadDecision({ ...base, own: null })).toBe("none");
    expect(reloadDecision({ ...base, served: null })).toBe("none");
    expect(reloadDecision({ ...base, sameOrigin: false })).toBe("none");
    expect(reloadDecision({ ...base, served: "b1" })).toBe("none");
  });

  it("reloads silently when nothing would be lost, else prompts", () => {
    expect(reloadDecision(base)).toBe("reload");
    expect(reloadDecision({ ...base, busy: true })).toBe("prompt");
  });

  it("never reloads twice for the same served build (no loop)", () => {
    expect(reloadDecision({ ...base, attempted: "b2" })).toBe("prompt");
    // A newer build than the one already tried: one more silent reload is fine.
    expect(reloadDecision({ ...base, served: "b3", attempted: "b2" })).toBe("reload");
  });

  it("never compares in dev / tests (no stamped id)", () => {
    expect(BUILD_ID).toBeNull();
  });
});

describe("busyReasons", () => {
  it("names what a reload would interrupt", () => {
    expect(busyReasons({ turnRunning: false, unsavedInput: false, pendingAttachments: false, mapEditing: false, dialogOpen: false })).toEqual([]);
    expect(busyReasons({ turnRunning: true, unsavedInput: true, pendingAttachments: true, mapEditing: true, dialogOpen: true })).toEqual([
      "an agent turn is running",
      "there is unsent input",
      "images are attached but not sent",
      "the map is being edited",
      "a dialog is open",
    ]);
  });

  it("counts images attached in any composer until they are sent or the composer goes", () => {
    expect(hasComposerPending()).toBe(false);
    setComposerPending("panel", 2);
    setComposerPending("page", 0);
    expect(hasComposerPending()).toBe(true);
    setComposerPending("page", 1);
    setComposerPending("panel", 0);
    expect(hasComposerPending()).toBe(true);
    setComposerPending("page", 0);
    expect(hasComposerPending()).toBe(false);
  });
});

describe("the one-reload guard", () => {
  it("records the served build before reloading, after the delay", () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    const reload = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal("window", { location: { reload } });
    expect(reloadAttempted()).toBeNull();
    expect(reloadForBuild("b2", 600)).toBe(true);
    expect(reloadAttempted()).toBe("b2");
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("marks the open project once, so the reloaded page skips its resume card", () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal("window", { location: { reload: vi.fn() } });
    expect(takeBuildReloadResume()).toBeNull();
    reloadForBuild("b2", 0, "proj-1");
    expect(takeBuildReloadResume()).toBe("proj-1");
    expect(takeBuildReloadResume()).toBeNull(); // read once
    // No project open: no mark (and an old one goes).
    store.set("ruah.buildReload.resumed", "stale");
    reloadForBuild("b3", 0, null);
    expect(takeBuildReloadResume()).toBeNull();
  });

  // Regression: a manual reload (⌘R) of the project in front showed "Welcome back … 1 permission
  // request waiting, 1 agent still working" — things that happened in front of the user.
  it("a manual reload marks the open project too (the page going away)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    markReloadResume("proj-2");
    expect(takeBuildReloadResume()).toBe("proj-2");
    expect(takeBuildReloadResume()).toBeNull();
    store.set("ruah.buildReload.resumed", "stale");
    markReloadResume(null);
    expect(takeBuildReloadResume()).toBeNull();
  });

  it("does not reload when the guard cannot be stored", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    vi.stubGlobal("window", { location: { reload } });
    expect(reloadAttempted()).toBeNull();
    expect(reloadForBuild("b2")).toBe(false);
    vi.runAllTimers();
    expect(reload).not.toHaveBeenCalled();
  });
});

// A tiny stand-in for the DOM queries the two helpers make.
function fakeDoc(fields: Partial<HTMLInputElement>[], editables: { textContent: string }[] = [], overlay = false): Document {
  return {
    querySelectorAll: (sel: string) => (sel.includes("contenteditable") ? editables : fields.map((f) => ({ classList: { contains: () => false }, ...f }))),
    querySelector: (sel: string) => (overlay && sel.includes("data-state=open") ? {} : null),
  } as unknown as Document;
}

describe("busy DOM checks", () => {
  it("counts typed text, not empty, read-only, disabled or terminal fields", () => {
    expect(hasUnsavedInput(fakeDoc([]))).toBe(false);
    expect(hasUnsavedInput(fakeDoc([{ value: "  " }, { value: "x", readOnly: true }, { value: "y", disabled: true }]))).toBe(false);
    expect(
      hasUnsavedInput(
        fakeDoc([{ value: "ls -la", classList: { contains: (c: string) => c === "xterm-helper-textarea" } as unknown as DOMTokenList }]),
      ),
    ).toBe(false);
    expect(hasUnsavedInput(fakeDoc([{ value: "fix the checkout" }]))).toBe(true);
    expect(hasUnsavedInput(fakeDoc([], [{ textContent: "draft" }]))).toBe(true);
  });

  it("sees an open dialog or menu", () => {
    expect(hasOpenOverlay(fakeDoc([]))).toBe(false);
    expect(hasOpenOverlay(fakeDoc([], [], true))).toBe(true);
  });
});
