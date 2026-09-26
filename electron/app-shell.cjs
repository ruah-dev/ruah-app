// electron/app-shell.cjs — the desktop shell's decisions, kept free of Electron
// imports so they are unit-tested (test/desktop-shell.test.ts): which folder a
// launch asks for, the app's name and flavor, where it keeps its Chromium
// profile, how big the window is, the application menu and the daemon log.
const crypto = require("node:crypto");
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

/** A build flavor (`RUAH_APP_FLAVOR`, e.g. "test"): lower-case letters, digits and dashes. */
const FLAVOR = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * The app's name from its package.json: "Ruah", or "Ruah <Flavor>" for a flavored
 * build (`RUAH_APP_FLAVOR=test pnpm dist` → "Ruah Test", bundle id dev.ruah.app.test;
 * electron-builder writes `ruahFlavor` into the packaged package.json).
 */
function appIdentity(pkg) {
  const flavor = pkg !== null && typeof pkg === "object" && typeof pkg.ruahFlavor === "string" && FLAVOR.test(pkg.ruahFlavor) ? pkg.ruahFlavor : "";
  if (flavor === "") return { name: "Ruah", flavor: "" };
  const title = flavor
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { name: `Ruah ${title}`, flavor };
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The profile and logs folder name: the app's name when packaged; for a source
 * checkout "<name> Dev-<8 hex of the checkout's real path>", so parallel
 * worktrees each get their own dev instance (and never hand off to the
 * installed app or to each other).
 */
function profileName({ isPackaged, appName = "Ruah", root }) {
  if (isPackaged || typeof root !== "string") return isPackaged ? appName : `${appName} Dev`;
  const id = crypto.createHash("sha256").update(realpathOr(root)).digest("hex").slice(0, 8);
  return `${appName} Dev-${id}`;
}

/**
 * Where Chromium keeps this instance's profile (localStorage, cache) and its
 * single-instance lock:
 * - RUAH_USER_DATA: exactly there;
 * - RUAH_HOME set: <RUAH_HOME>/desktop (its own profile and lock — but macOS still
 *   routes `open -a` / Finder folders by bundle id, see confirmOpenFile);
 * - otherwise <appData>/<profileName>: "Ruah" packaged, "Ruah Dev-<id>" per checkout.
 */
function userDataDir({ isPackaged, env = process.env, appData, appName = "Ruah", root }) {
  const explicit = typeof env.RUAH_USER_DATA === "string" ? env.RUAH_USER_DATA.trim() : "";
  if (explicit.length > 0) return path.resolve(explicit);
  const home = typeof env.RUAH_HOME === "string" ? env.RUAH_HOME.trim() : "";
  if (home.length > 0) return path.join(path.resolve(home), "desktop");
  return path.join(appData, profileName({ isPackaged, appName, root }));
}

/** Where the daemon log goes: <RUAH_HOME>/logs for a scratch home, else `defaultDir` (~/Library/Logs/<profileName>). */
function logsDir({ env = process.env, defaultDir }) {
  const home = typeof env.RUAH_HOME === "string" ? env.RUAH_HOME.trim() : "";
  return home.length > 0 ? path.join(path.resolve(home), "logs") : defaultDir;
}

/**
 * Whether a folder that reached this instance through `open-file` needs a yes first.
 * macOS delivers `open -a Ruah <dir>`, Finder "Open With" and Dock drops to whichever
 * app with this bundle id runs, whatever its RUAH_HOME: an instance on a scratch home
 * asks before it maps (and writes architecture.json into) a folder it may not be meant
 * for. The folder of its own launch (before the first window) is trusted.
 */
function confirmOpenFile({ env = process.env, launched }) {
  const home = typeof env.RUAH_HOME === "string" ? env.RUAH_HOME.trim() : "";
  return launched === true && home.length > 0;
}

/**
 * Who holds a profile's single-instance lock: Chromium's SingletonLock symlink
 * points at "<host>-<pid>". Undefined when it is not there or unreadable.
 */
function lockOwner(userDataPath) {
  try {
    const target = fs.readlinkSync(path.join(userDataPath, "SingletonLock"));
    const match = /-(\d+)$/.exec(target);
    return match !== null ? { pid: Number.parseInt(match[1], 10) } : undefined;
  } catch {
    return undefined;
  }
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

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Keeps one previous log: daemon.log → daemon.1.log once it passes `maxBytes`. */
function rotateLog(file, maxBytes = LOG_MAX_BYTES) {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    fs.renameSync(file, file.replace(/\.log$/, ".1.log"));
    return true;
  } catch {
    return false;
  }
}

/**
 * An append-only log that rotates itself (daemon.log → daemon.1.log) whenever the
 * next write would take it past `maxBytes` — the app stays in the Dock for days while
 * the daemon keeps writing. Never throws; a failing disk just stops the log.
 */
function openRotatingLog(file, { maxBytes = LOG_MAX_BYTES } = {}) {
  let stream = null;
  let size = 0;
  const open = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateLog(file, maxBytes);
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      // Opened now (not lazily by the stream): a rename right after must move this very file.
      const next = fs.createWriteStream(file, { fd: fs.openSync(file, "a") });
      next.on("error", () => {
        if (stream === next) stream = null;
      });
      stream = next;
    } catch {
      stream = null;
    }
  };
  open();
  return {
    write(chunk) {
      if (stream === null) return;
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > 0 && size + bytes > maxBytes) {
        // The old stream keeps its descriptor: what it still has to flush lands in daemon.1.log.
        const old = stream;
        try {
          fs.renameSync(file, file.replace(/\.log$/, ".1.log"));
        } catch {
          // keep appending to whatever is there
        }
        old.end();
        stream = null;
        open();
        if (stream === null) return;
      }
      stream.write(chunk);
      size += bytes;
    },
    /** Resolves once everything written so far is on disk. */
    end() {
      const current = stream;
      stream = null;
      return new Promise((resolve) => {
        if (current === null) resolve();
        else current.end(resolve);
      });
    },
  };
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
  FLAVOR,
  repoFromArgv,
  secondInstanceFolder,
  appIdentity,
  profileName,
  userDataDir,
  logsDir,
  confirmOpenFile,
  lockOwner,
  seedProfile,
  windowBounds,
  readJson,
  writeJson,
  rotateLog,
  openRotatingLog,
  buildMenuTemplate,
};
