// electron/app-shell.cjs — the desktop shell's decisions, kept free of Electron
// imports so they are unit-tested (test/desktop-shell.test.ts): which folder a
// launch asks for, where the app keeps its Chromium profile, how big the
// window is, the application menu and the daemon log rotation.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder a launch asks to open, from a command line:
 * dev `electron <app> [folder]` (argv[0] Electron, argv[1] the app path) or
 * packaged `Ruah [folder]` (argv[0] the app binary). Chromium / macOS switches
 * (`--foo`, `-psn_…`) are ignored wherever they appear; after `--` everything
 * is a user argument. Relative folders resolve against `cwd`.
 */
function repoFromArgv(argv, { isPackaged, cwd = process.cwd() } = {}) {
  const list = Array.isArray(argv) ? argv.filter((a) => typeof a === "string") : [];
  const sep = list.indexOf("--");
  let candidates;
  if (sep !== -1) {
    candidates = list.slice(sep + 1);
  } else {
    const positionals = list.filter((a) => !a.startsWith("-"));
    candidates = positionals.slice(isPackaged ? 1 : 2);
  }
  for (const candidate of candidates) {
    if (candidate.startsWith("-") || candidate === ".") continue;
    const absolute = path.resolve(cwd, candidate);
    if (isDirectory(absolute)) return absolute;
  }
  return undefined;
}

/**
 * The folder a second instance asks for. Our instances pass
 * `{ folder: string | null }` as the lock's additionalData, which wins (null =
 * no folder); only without it is the second instance's argv parsed.
 */
function secondInstanceFolder(additionalData, argv, { isPackaged, cwd }) {
  if (additionalData !== null && typeof additionalData === "object" && "folder" in additionalData) {
    const folder = additionalData.folder;
    return typeof folder === "string" && path.isAbsolute(folder) && isDirectory(folder) ? folder : undefined;
  }
  return repoFromArgv(argv, { isPackaged, cwd });
}

/**
 * Where Chromium keeps this instance's profile (localStorage, cache) and its
 * single-instance lock:
 * - RUAH_USER_DATA: exactly there;
 * - RUAH_HOME set: <RUAH_HOME>/desktop — a scratch home is a separate, isolated instance;
 * - dev (`pnpm app`): <appData>/Ruah Dev, so a source checkout never hands off to the installed app;
 * - packaged: undefined (Electron's default, <appData>/Ruah).
 */
function userDataDir({ isPackaged, env = process.env, appData }) {
  const explicit = typeof env.RUAH_USER_DATA === "string" ? env.RUAH_USER_DATA.trim() : "";
  if (explicit.length > 0) return path.resolve(explicit);
  const home = typeof env.RUAH_HOME === "string" ? env.RUAH_HOME.trim() : "";
  if (home.length > 0) return path.join(path.resolve(home), "desktop");
  if (!isPackaged) return path.join(appData, "Ruah Dev");
  return undefined;
}

/** Where the daemon log goes: <RUAH_HOME>/logs for a scratch home, else Electron's logs dir (~/Library/Logs/Ruah). */
function logsDir({ env = process.env, defaultDir }) {
  const home = typeof env.RUAH_HOME === "string" ? env.RUAH_HOME.trim() : "";
  return home.length > 0 ? path.join(path.resolve(home), "logs") : defaultDir;
}

/**
 * First dev launch after the split from the shared profile: copy the viewer's
 * saved preferences (Local Storage) so `pnpm app` keeps them. Never overwrites.
 */
function seedProfile(fromDir, toDir) {
  const source = path.join(fromDir, "Local Storage");
  const target = path.join(toDir, "Local Storage");
  if (!isDirectory(source) || fs.existsSync(target)) return false;
  try {
    fs.mkdirSync(toDir, { recursive: true });
    fs.cpSync(source, target, { recursive: true, filter: (src) => path.basename(src) !== "LOCK" });
    return true;
  } catch {
    return false;
  }
}

function finite(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * The window's bounds: the saved ones when they still fit a display (a
 * monitor may be gone), else 1440×900 shrunk to 90 % of the primary work area
 * and centred. Never below the minimum size.
 */
function windowBounds(saved, workAreas) {
  const areas = Array.isArray(workAreas) && workAreas.length > 0 ? workAreas : [{ x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }];
  const primary = areas[0];
  if (saved !== null && typeof saved === "object" && [saved.x, saved.y, saved.width, saved.height].every(finite)) {
    const area = areas.find(
      (a) => saved.x + 80 <= a.x + a.width && saved.x + saved.width - 80 >= a.x && saved.y >= a.y - 10 && saved.y + 40 <= a.y + a.height,
    );
    if (area !== undefined) {
      const width = Math.max(MIN_WIDTH, Math.min(saved.width, area.width));
      const height = Math.max(MIN_HEIGHT, Math.min(saved.height, area.height));
      return { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(width), height: Math.round(height), maximized: saved.maximized === true };
    }
  }
  const width = Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, Math.floor(primary.width * 0.9)));
  const height = Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, Math.floor(primary.height * 0.9)));
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height,
    maximized: false,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // window placement is a convenience
  }
}

/** Keeps one previous log: daemon.log → daemon.1.log once it passes `maxBytes`. */
function rotateLog(file, maxBytes = 5 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    fs.renameSync(file, file.replace(/\.log$/, ".1.log"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The application menu (macOS layout: Ruah, File, Edit, View, Window, Help).
 * `actions` are click handlers from main.cjs. Shortcuts the viewer handles
 * itself (⌘O, ⌘= / ⌘- / ⌘0 for the terminal font) are shown but not
 * registered, so the menu never steals them from the page.
 */
function buildMenuTemplate({ appName = "Ruah", isDev = false, platform = process.platform, actions = {} }) {
  const call = (name) => () => {
    const fn = actions[name];
    if (typeof fn === "function") fn();
  };
  const isMac = platform === "darwin";
  const appMenu = {
    label: appName,
    submenu: [
      { role: "about", label: `About ${appName}` },
      { type: "separator" },
      { id: "settings", label: "Settings…", accelerator: "CmdOrCtrl+,", click: call("openSettings") },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide", label: `Hide ${appName}` },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit", label: `Quit ${appName}` },
    ],
  };
  const fileMenu = {
    label: "File",
    submenu: [
      { id: "open-folder", label: "Open Folder…", accelerator: "CmdOrCtrl+O", registerAccelerator: false, click: call("openFolder") },
      { type: "separator" },
      { role: "close", label: "Close Window" },
    ],
  };
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  };
  const viewMenu = {
    label: "View",
    submenu: [
      { role: "reload", accelerator: "CmdOrCtrl+R" },
      { role: "forceReload", accelerator: "Shift+CmdOrCtrl+R" },
      ...(isDev ? [{ role: "toggleDevTools", accelerator: "Alt+CmdOrCtrl+I" }] : []),
      { type: "separator" },
      { role: "resetZoom", registerAccelerator: false },
      { role: "zoomIn", registerAccelerator: false },
      { role: "zoomOut", registerAccelerator: false },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const windowMenu = {
    label: "Window",
    role: "window",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  };
  const helpMenu = {
    label: "Help",
    role: "help",
    submenu: [
      { id: "help-site", label: `${appName} on GitHub`, click: call("openHelp") },
      { id: "show-logs", label: "Show Logs in Finder", click: call("showLogs") },
    ],
  };
  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  repoFromArgv,
  secondInstanceFolder,
  userDataDir,
  logsDir,
  seedProfile,
  windowBounds,
  readJson,
  writeJson,
  rotateLog,
  buildMenuTemplate,
};
