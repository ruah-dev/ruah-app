// ui/test/theme-store.test.ts — the theme and palette stores behind useTheme / usePalette
// (ui/src/lib/theme.ts): the session's choice is the truth (a choice holds when localStorage
// throws), theme and palette never re-apply each other, other windows follow through the storage
// event, and a `dusk` saved before the palettes followed the design system gets a one-time note.
// No DOM library here: window / document are small fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ThemeModule = typeof import("@/lib/theme");

interface Env {
  data: Map<string, string>;
  root: { classList: { contains(c: string): boolean }; dataset: Record<string, string>; style: { colorScheme?: string } };
  /** Fire a `storage` event as another window's write would. */
  storageEvent(key: string | null, newValue: string | null): void;
}

function fakeBrowser(opts: { initial?: Record<string, string>; throws?: boolean } = {}): Env {
  const data = new Map(Object.entries(opts.initial ?? {}));
  const deny = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  const localStorage = {
    getItem: (k: string) => (opts.throws ? deny() : (data.get(k) ?? null)),
    setItem: (k: string, v: string) => (opts.throws ? deny() : void data.set(k, v)),
  };
  const events = new EventTarget();
  const classes = new Set<string>(["dark"]);
  const root = {
    classList: {
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c), on),
    },
    dataset: { theme: "dark" } as Record<string, string>,
    style: {} as { colorScheme?: string },
  };
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("document", { documentElement: root });
  return {
    data,
    root,
    storageEvent(key, newValue) {
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
    },
  };
}

async function load(): Promise<ThemeModule> {
  vi.resetModules();
  return import("@/lib/theme");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("theme and palette stores", () => {
  it("apply, persist and notify", async () => {
    const env = fakeBrowser();
    const { themeStore, paletteStore } = await load();
    const heard: string[] = [];
    const off = themeStore.subscribe(() => heard.push(themeStore.get()));
    themeStore.set("light");
    expect(env.root.dataset["theme"]).toBe("light");
    expect(env.root.classList.contains("light")).toBe(true);
    expect(env.data.get("ruah.theme")).toBe("light");
    expect(heard).toEqual(["light"]);
    paletteStore.set("sunrise");
    expect(env.root.dataset["palette"]).toBe("sunrise");
    expect(env.data.get("ruah.palette")).toBe("sunrise");
    paletteStore.set("teal");
    expect(env.root.dataset["palette"]).toBeUndefined();
    off();
  });

  it("read the saved values once", async () => {
    fakeBrowser({ initial: { "ruah.theme": "contrast", "ruah.palette": "classic" } });
    const { readTheme, readPalette } = await load();
    expect(readTheme()).toBe("contrast");
    expect(readPalette()).toBe("classic");
  });

  it("fall back on unknown saved values", async () => {
    fakeBrowser({ initial: { "ruah.theme": "sepia", "ruah.palette": "neon" } });
    const { readTheme, readPalette } = await load();
    expect(readTheme()).toBe("dark");
    expect(readPalette()).toBe("teal");
  });

  it("keep the session's choice when localStorage throws", async () => {
    const env = fakeBrowser({ throws: true });
    const { themeStore, paletteStore, readTheme, readPalette } = await load();
    const seen: string[] = [];
    const offTheme = themeStore.subscribe(() => seen.push(`theme:${themeStore.get()}`));
    const offPalette = paletteStore.subscribe(() => seen.push(`palette:${paletteStore.get()}`));
    themeStore.set("light");
    expect(env.root.dataset["theme"]).toBe("light");
    expect(themeStore.get()).toBe("light");
    // Every other switcher (and one mounted later) reads the session's value, not the fallback.
    expect(readTheme()).toBe("light");
    paletteStore.set("sunrise");
    expect(env.root.dataset["palette"]).toBe("sunrise");
    expect(readPalette()).toBe("sunrise");
    expect(seen).toEqual(["theme:light", "palette:sunrise"]);
    offTheme();
    offPalette();
  });

  it("a theme change never re-applies the palette, nor the reverse", async () => {
    const env = fakeBrowser({ throws: true });
    const { themeStore, paletteStore } = await load();
    const offT = themeStore.subscribe(() => {});
    const offP = paletteStore.subscribe(() => {});
    paletteStore.set("dusk");
    // Something else (a preview, the boot script) moves the palette attribute: a theme change
    // must leave it alone.
    env.root.dataset["palette"] = "classic";
    themeStore.set("contrast");
    expect(env.root.dataset["palette"]).toBe("classic");
    env.root.dataset["theme"] = "light";
    paletteStore.set("sunrise");
    expect(env.root.dataset["theme"]).toBe("light");
    offT();
    offP();
  });

  it("follow another window through the storage event, per key", async () => {
    const env = fakeBrowser({ initial: { "ruah.theme": "dark", "ruah.palette": "teal" } });
    const { themeStore, paletteStore } = await load();
    let themeCalls = 0;
    let paletteCalls = 0;
    const offT = themeStore.subscribe(() => themeCalls++);
    const offP = paletteStore.subscribe(() => paletteCalls++);
    env.storageEvent("ruah.theme", "light");
    expect(themeStore.get()).toBe("light");
    expect(env.root.dataset["theme"]).toBe("light");
    expect([themeCalls, paletteCalls]).toEqual([1, 0]);
    env.storageEvent("ruah.palette", "sunrise");
    expect(paletteStore.get()).toBe("sunrise");
    expect([themeCalls, paletteCalls]).toEqual([1, 1]);
    env.storageEvent("ruah.palette", "bogus");
    expect(paletteStore.get()).toBe("teal");
    env.storageEvent("unrelated", "x");
    expect([themeCalls, paletteCalls]).toEqual([1, 2]);
    // No subscribers, no listener: later events are ignored.
    offT();
    offP();
    env.storageEvent("ruah.theme", "contrast");
    expect(themeStore.get()).toBe("light");
  });
});

describe("the Dusk → Indigo note", () => {
  it("shows for a dusk saved before the palettes followed the design system", async () => {
    const env = fakeBrowser({ initial: { "ruah.palette": "dusk" } });
    const { paletteNotice, dismissPaletteNotice, paletteStore } = await load();
    expect(paletteNotice()).toBe(true);
    dismissPaletteNotice();
    expect(paletteNotice()).toBe(false);
    expect(env.data.get("ruah.palette.v")).toBe("2");
    expect(paletteStore.get()).toBe("dusk");
  });

  it("ends once any palette is chosen", async () => {
    const env = fakeBrowser({ initial: { "ruah.palette": "dusk" } });
    const { paletteNotice, paletteStore } = await load();
    expect(paletteNotice()).toBe(true);
    paletteStore.set("dusk");
    expect(paletteNotice()).toBe(false);
    expect(env.data.get("ruah.palette.v")).toBe("2");
  });

  it("stays away for a dusk chosen since, other palettes, and without storage", async () => {
    fakeBrowser({ initial: { "ruah.palette": "dusk", "ruah.palette.v": "2" } });
    expect((await load()).paletteNotice()).toBe(false);
    vi.unstubAllGlobals();
    fakeBrowser({ initial: { "ruah.palette": "sunrise" } });
    expect((await load()).paletteNotice()).toBe(false);
    vi.unstubAllGlobals();
    fakeBrowser({ throws: true });
    expect((await load()).paletteNotice()).toBe(false);
  });
});
