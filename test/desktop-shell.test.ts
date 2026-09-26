// electron/app-shell.cjs: the desktop shell's decisions (no Electron needed).
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface MenuItem {
  id?: string;
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  registerAccelerator?: boolean;
  click?: () => void;
  submenu?: MenuItem[];
}
interface AppShell {
  MIN_WIDTH: number;
  MIN_HEIGHT: number;
  repoFromArgv(argv: string[], options: { isPackaged: boolean; cwd?: string }): string | undefined;
  secondInstanceFolder(data: unknown, argv: string[], options: { isPackaged: boolean; cwd: string }): string | undefined;
  appIdentity(pkg: unknown): { name: string; flavor: string };
  profileName(options: { isPackaged: boolean; appName?: string; root?: string }): string;
  userDataDir(options: { isPackaged: boolean; env: Record<string, string | undefined>; appData: string; appName?: string; root?: string }): string;
  logsDir(options: { env: Record<string, string | undefined>; defaultDir: string }): string;
  confirmOpenFile(options: { env: Record<string, string | undefined>; launched: boolean }): boolean;
  lockOwner(userData: string): { pid: number } | undefined;
  seedProfile(from: string, to: string): boolean;
  windowBounds(saved: unknown, areas: Rect[]): Rect & { maximized: boolean };
  rotateLog(file: string, maxBytes?: number): boolean;
  openRotatingLog(file: string, options?: { maxBytes?: number }): { write(chunk: string | Buffer): void; end(): Promise<void> };
  buildMenuTemplate(options: { appName?: string; isDev?: boolean; platform?: string; actions?: Record<string, () => void> }): MenuItem[];
}

const shell = createRequire(import.meta.url)("../electron/app-shell.cjs") as AppShell;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-shell-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("which folder a launch asks for", () => {
  test("dev: `electron <app> <folder>`; packaged: `Ruah <folder>`; switches ignored anywhere", () => {
    const dir = tempDir();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const app = join(dir, "app"); // the app path itself is a directory too: never the answer in dev
    mkdirSync(app);
    expect(shell.repoFromArgv(["/electron", app], { isPackaged: false })).toBeUndefined();
    expect(shell.repoFromArgv(["/electron", ".", repo], { isPackaged: false })).toBe(repo);
    expect(shell.repoFromArgv(["/electron", "--allow-file-access-from-files", app, "--original-process-start-time=1", repo], { isPackaged: false })).toBe(repo);
    expect(shell.repoFromArgv(["/Ruah.app/Contents/MacOS/Ruah", "-psn_0_12345", repo], { isPackaged: true })).toBe(repo);
    expect(shell.repoFromArgv(["/Ruah", "repo"], { isPackaged: true, cwd: dir })).toBe(repo);
    expect(shell.repoFromArgv(["/Ruah", join(dir, "missing")], { isPackaged: true })).toBeUndefined();
    expect(shell.repoFromArgv(["/Ruah", "--", repo], { isPackaged: true })).toBe(repo);
  });

  test("a second instance's own answer (additionalData) wins over its argv", () => {
    const dir = tempDir();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const options = { isPackaged: true, cwd: dir };
    expect(shell.secondInstanceFolder({ folder: repo }, ["/Ruah"], options)).toBe(repo);
    expect(shell.secondInstanceFolder({ folder: null }, ["/Ruah", repo], options)).toBeUndefined();
    expect(shell.secondInstanceFolder({ folder: "relative" }, ["/Ruah"], options)).toBeUndefined();
    expect(shell.secondInstanceFolder(null, ["/Ruah", repo], options)).toBe(repo);
  });
});

describe("name, flavor, profile and logs", () => {
  test("the app is Ruah; a flavored build (package.json ruahFlavor) is `Ruah <Flavor>`", () => {
    expect(shell.appIdentity({ name: "@ruah-dev/app" })).toEqual({ name: "Ruah", flavor: "" });
    expect(shell.appIdentity({ ruahFlavor: "test" })).toEqual({ name: "Ruah Test", flavor: "test" });
    expect(shell.appIdentity({ ruahFlavor: "side-by-side" })).toEqual({ name: "Ruah Side By Side", flavor: "side-by-side" });
    expect(shell.appIdentity({ ruahFlavor: "../Evil" })).toEqual({ name: "Ruah", flavor: "" });
    expect(shell.appIdentity(null)).toEqual({ name: "Ruah", flavor: "" });
  });

  test("RUAH_USER_DATA, then a scratch RUAH_HOME, then one dev profile per checkout; packaged: <appData>/<name>", () => {
    const appData = "/Users/me/Library/Application Support";
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_USER_DATA: "/tmp/profile" }, appData })).toBe("/tmp/profile");
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_HOME: "/tmp/scratch" }, appData })).toBe("/tmp/scratch/desktop");
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_HOME: "  " }, appData })).toBe(`${appData}/Ruah`);
    expect(shell.userDataDir({ isPackaged: true, env: {}, appData, appName: "Ruah Test" })).toBe(`${appData}/Ruah Test`);
    expect(shell.userDataDir({ isPackaged: false, env: {}, appData, root: "/code/ruah-app" })).toMatch(/\/Ruah Dev-[0-9a-f]{8}$/);
    expect(shell.logsDir({ env: { RUAH_HOME: "/tmp/scratch" }, defaultDir: "/Users/me/Library/Logs/Ruah" })).toBe("/tmp/scratch/logs");
    expect(shell.logsDir({ env: {}, defaultDir: "/Users/me/Library/Logs/Ruah" })).toBe("/Users/me/Library/Logs/Ruah");
  });

  test("each checkout (worktree) gets its own dev profile — stable, and the same through a symlink", () => {
    const dir = tempDir();
    const a = join(dir, "ruah-app");
    const b = join(dir, "wt-feature");
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(a, join(dir, "link"));
    const name = (root: string): string => shell.profileName({ isPackaged: false, root });
    expect(name(a)).toMatch(/^Ruah Dev-[0-9a-f]{8}$/);
    expect(name(a)).toBe(name(a));
    expect(name(b)).not.toBe(name(a));
    expect(name(join(dir, "link"))).toBe(name(a));
    expect(shell.profileName({ isPackaged: true, root: a })).toBe("Ruah");
    expect(shell.profileName({ isPackaged: true, appName: "Ruah Test" })).toBe("Ruah Test");
  });

  test("a scratch-home instance asks before opening a folder macOS routed to it after launch", () => {
    expect(shell.confirmOpenFile({ env: { RUAH_HOME: "/tmp/scratch" }, launched: true })).toBe(true);
    expect(shell.confirmOpenFile({ env: { RUAH_HOME: "/tmp/scratch" }, launched: false })).toBe(false); // its own launch folder
    expect(shell.confirmOpenFile({ env: {}, launched: true })).toBe(false);
    expect(shell.confirmOpenFile({ env: { RUAH_HOME: " " }, launched: true })).toBe(false);
  });

  test("the lock's owner comes from Chromium's SingletonLock (<host>-<pid>)", () => {
    const dir = tempDir();
    expect(shell.lockOwner(dir)).toBeUndefined();
    symlinkSync("my-mac.local-4242", join(dir, "SingletonLock"));
    expect(shell.lockOwner(dir)).toEqual({ pid: 4242 });
  });

  test("the dev profile is seeded once with the viewer's saved preferences (no lock files)", () => {
    const dir = tempDir();
    const from = join(dir, "Ruah");
    const to = join(dir, "Ruah Dev");
    mkdirSync(join(from, "Local Storage", "leveldb"), { recursive: true });
    writeFileSync(join(from, "Local Storage", "leveldb", "000003.log"), "prefs");
    writeFileSync(join(from, "Local Storage", "leveldb", "LOCK"), "");
    expect(shell.seedProfile(from, to)).toBe(true);
    expect(readFileSync(join(to, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("prefs");
    expect(existsSync(join(to, "Local Storage", "leveldb", "LOCK"))).toBe(false);
    writeFileSync(join(from, "Local Storage", "leveldb", "000003.log"), "newer");
    expect(shell.seedProfile(from, to)).toBe(false); // never overwrites
    expect(readFileSync(join(to, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("prefs");
    expect(shell.seedProfile(join(dir, "none"), join(dir, "other"))).toBe(false);
  });

  test("the daemon log keeps one previous file", () => {
    const dir = tempDir();
    const file = join(dir, "daemon.log");
    writeFileSync(file, "x".repeat(100));
    expect(shell.rotateLog(file, 1000)).toBe(false);
    expect(shell.rotateLog(file, 50)).toBe(true);
    expect(readFileSync(join(dir, "daemon.1.log"), "utf8")).toHaveLength(100);
    expect(existsSync(file)).toBe(false);
    expect(shell.rotateLog(file, 50)).toBe(false);
  });

  test("a long-running log rotates itself when a write would pass the limit", async () => {
    const dir = tempDir();
    const file = join(dir, "daemon.log");
    writeFileSync(file, "old\n");
    const log = shell.openRotatingLog(file, { maxBytes: 100 });
    for (let i = 0; i < 10; i += 1) log.write(`line ${i} ${"x".repeat(20)}\n`); // 28 bytes each
    await log.end();
    const current = readFileSync(file, "utf8");
    const previous = readFileSync(join(dir, "daemon.1.log"), "utf8");
    expect(current.length).toBeLessThanOrEqual(100);
    expect(previous.length).toBeLessThanOrEqual(100);
    // 28-byte lines, 100-byte limit: rotated before lines 3, 6 and 9; one previous file is kept.
    expect(current).toBe(`line 9 ${"x".repeat(20)}\n`);
    expect(previous.trim().split("\n").map((l) => l.slice(0, 6))).toEqual(["line 6", "line 7", "line 8"]);
    log.write("after end is ignored\n");
  });
});

describe("window bounds", () => {
  const laptop = { x: 0, y: 25, width: 1512, height: 944 };
  test("first launch: 1440×900 fitted into 90 % of the screen, centred", () => {
    const b = shell.windowBounds(null, [laptop]);
    expect(b).toMatchObject({ width: 1360, height: 849, maximized: false });
    expect(b.x).toBe(76);
    expect(shell.windowBounds(null, [{ x: 0, y: 0, width: 2560, height: 1440 }])).toMatchObject({ width: 1440, height: 900 });
  });

  test("saved bounds come back while they are on a screen; a gone monitor falls back", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800, maximized: true };
    expect(shell.windowBounds(saved, [laptop])).toEqual({ x: 100, y: 80, width: 1200, height: 800, maximized: true });
    const external = { x: 1512, y: 0, width: 2560, height: 1440 };
    const onExternal = { x: 1800, y: 100, width: 1600, height: 1000 };
    expect(shell.windowBounds(onExternal, [laptop, external])).toMatchObject({ x: 1800, width: 1600 });
    expect(shell.windowBounds(onExternal, [laptop])).toMatchObject({ x: 76, width: 1360 });
    expect(shell.windowBounds({ x: "a" }, [laptop])).toMatchObject({ x: 76 });
  });

  test("never below the minimum size, even on a tiny screen", () => {
    const b = shell.windowBounds({ x: 0, y: 0, width: 200, height: 100 }, [{ x: 0, y: 0, width: 800, height: 500 }]);
    expect(b.width).toBe(shell.MIN_WIDTH);
    expect(b.height).toBe(shell.MIN_HEIGHT);
  });
});

describe("application menu", () => {
  const find = (items: MenuItem[], pred: (i: MenuItem) => boolean): MenuItem | undefined => {
    for (const item of items) {
      if (pred(item)) return item;
      const inner = item.submenu !== undefined ? find(item.submenu, pred) : undefined;
      if (inner !== undefined) return inner;
    }
    return undefined;
  };

  test("Ruah / File / Edit / View / Window / Help with the standard roles", () => {
    const menu = shell.buildMenuTemplate({ appName: "Ruah", isDev: false, platform: "darwin" });
    expect(menu.map((m) => m.label)).toEqual(["Ruah", "File", "Edit", "View", "Window", "Help"]);
    const roles = (label: string): string[] => (menu.find((m) => m.label === label)?.submenu ?? []).flatMap((i) => (i.role !== undefined ? [i.role] : []));
    expect(roles("Ruah")).toEqual(["about", "services", "hide", "hideOthers", "unhide", "quit"]);
    expect(find(menu, (i) => i.role === "about")?.label).toBe("About Ruah");
    expect(find(menu, (i) => i.role === "quit")?.label).toBe("Quit Ruah");
    expect(roles("Edit")).toEqual(["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]);
    expect(roles("Window")).toEqual(["minimize", "zoom", "front"]);
    expect(find(menu, (i) => i.role === "reload")?.accelerator).toBe("CmdOrCtrl+R");
  });

  test("developer tools only in dev", () => {
    const hasDevtools = (isDev: boolean): boolean =>
      find(shell.buildMenuTemplate({ isDev, platform: "darwin" }), (i) => i.role === "toggleDevTools") !== undefined;
    expect(hasDevtools(false)).toBe(false);
    expect(hasDevtools(true)).toBe(true);
  });

  test("shortcuts the viewer owns are shown but not registered; items call their actions", () => {
    const calls: string[] = [];
    const actions = Object.fromEntries(["openFolder", "openSettings", "openHelp", "showLogs"].map((name) => [name, () => calls.push(name)]));
    const menu = shell.buildMenuTemplate({ platform: "darwin", actions });
    const open = find(menu, (i) => i.id === "open-folder");
    expect(open).toMatchObject({ accelerator: "CmdOrCtrl+O", registerAccelerator: false });
    for (const role of ["resetZoom", "zoomIn", "zoomOut"]) expect(find(menu, (i) => i.role === role)?.registerAccelerator).toBe(false);
    expect(find(menu, (i) => i.id === "settings")?.accelerator).toBe("CmdOrCtrl+,");
    for (const id of ["open-folder", "settings", "help-site", "show-logs"]) find(menu, (i) => i.id === id)?.click?.();
    expect(calls).toEqual(["openFolder", "openSettings", "openHelp", "showLogs"]);
  });
});
