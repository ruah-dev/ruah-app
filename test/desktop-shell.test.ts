// electron/app-shell.cjs: the desktop shell's decisions (no Electron needed).
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  userDataDir(options: { isPackaged: boolean; env: Record<string, string | undefined>; appData: string }): string | undefined;
  logsDir(options: { env: Record<string, string | undefined>; defaultDir: string }): string;
  seedProfile(from: string, to: string): boolean;
  windowBounds(saved: unknown, areas: Rect[]): Rect & { maximized: boolean };
  rotateLog(file: string, maxBytes?: number): boolean;
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

describe("profile and logs", () => {
  test("RUAH_USER_DATA, then a scratch RUAH_HOME, then `Ruah Dev` for a checkout; packaged keeps Electron's default", () => {
    const appData = "/Users/me/Library/Application Support";
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_USER_DATA: "/tmp/profile" }, appData })).toBe("/tmp/profile");
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_HOME: "/tmp/scratch" }, appData })).toBe("/tmp/scratch/desktop");
    expect(shell.userDataDir({ isPackaged: false, env: {}, appData })).toBe(`${appData}/Ruah Dev`);
    expect(shell.userDataDir({ isPackaged: true, env: { RUAH_HOME: "  " }, appData })).toBeUndefined();
    expect(shell.logsDir({ env: { RUAH_HOME: "/tmp/scratch" }, defaultDir: "/Users/me/Library/Logs/Ruah" })).toBe("/tmp/scratch/logs");
    expect(shell.logsDir({ env: {}, defaultDir: "/Users/me/Library/Logs/Ruah" })).toBe("/Users/me/Library/Logs/Ruah");
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
