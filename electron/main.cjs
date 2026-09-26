const { app, BrowserWindow, Menu, Notification, dialog, globalShortcut, ipcMain, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const desktop = require("./app-shell.cjs");
const { sameOrigin, webUrl } = require("./links.cjs");

// 4177 when it is free (keeps the viewer's saved preferences, which are per
// origin); otherwise any free port, so a second window or a leftover process
// never blocks the app. RUAH_PORT forces a port.
const PREFERRED_PORT = Number.parseInt(process.env.RUAH_PORT ?? "4177", 10);
let PORT = PREFERRED_PORT;
let BASE = `http://127.0.0.1:${PORT}`;
// dev: the checkout; packaged: Ruah.app/Contents/Resources/app (asar off: the
// daemon is a plain Node program that spawns binaries from its node_modules).
const ROOT = path.join(__dirname, "..");
const PKG = require(path.join(ROOT, "package.json"));
const VERSION = PKG.version;
// "Ruah", or "Ruah <Flavor>" for a side-by-side build (RUAH_APP_FLAVOR, its own bundle id).
const APP_NAME = desktop.appIdentity(PKG).name;
const IS_DEV = !app.isPackaged;
const DEVTOOLS = IS_DEV || process.env.RUAH_DEVTOOLS === "1";
// Ruah brand mark (from ruah-website public/brand/ruah-icon.svg, on the macOS
// 1024 icon grid); icon.icns is the packaged app's icon.
const APP_ICON = path.join(__dirname, "assets", "icon.png");
const HELP_URL = "https://github.com/ruah-dev";
// RUAH_AGENT picks the initial agent (unset: the saved default agent, else "claude"):
// "cursor", "grok", "kiro", "opencode", "acp" (Claude through the ACP adapter) or "mock"
// (scripted, no agent). The viewer can switch agents at runtime.
const AGENT = process.env.RUAH_AGENT;
// The built viewer (`pnpm ui:build` → viewer/); RUAH_VIEWER overrides it.
const VIEWER_DIR = process.env.RUAH_VIEWER ?? path.join(ROOT, "viewer");

// ---------- identity, profile and single instance (before `ready`) ----------

app.setName(APP_NAME);
// Packaged: ~/Library/Application Support/Ruah; a checkout: "Ruah Dev-<id>" of its own (one dev
// instance per worktree); RUAH_HOME / RUAH_USER_DATA: there (CONTRACTS §15.5).
const PROFILE_NAME = desktop.profileName({ isPackaged: app.isPackaged, appName: APP_NAME, root: ROOT });
const profileDir = desktop.userDataDir({ isPackaged: app.isPackaged, env: process.env, appData: app.getPath("appData"), appName: APP_NAME, root: ROOT });
// `pnpm app` used to share the installed app's profile: carry the viewer's preferences over once.
if (IS_DEV && process.env.RUAH_HOME === undefined && process.env.RUAH_USER_DATA === undefined) {
  desktop.seedProfile(path.join(app.getPath("appData"), "Ruah"), profileDir);
}
app.setPath("userData", profileDir);
app.setAppLogsPath(desktop.logsDir({ env: process.env, defaultDir: path.join(app.getPath("home"), "Library", "Logs", PROFILE_NAME) }));
const LOG_FILE = path.join(app.getPath("logs"), "daemon.log");
const WINDOW_STATE = path.join(app.getPath("userData"), "window-state.json");

const startupFolder = process.env.RUAH_REPO ?? desktop.repoFromArgv(process.argv, { isPackaged: app.isPackaged });
// One Ruah per profile: `open -a Ruah <dir>`, `ruah app <dir>` and a second
// launch hand their folder to the running one (second-instance / open-file).
const primary = app.requestSingleInstanceLock({ folder: startupFolder ?? null });

let daemon = null;
let daemonReady = false;
let daemonReadyOnce = false; // a crash after the first successful start offers a restart
let win = null;
let quitting = false;
let logStream = null;
let restartOffered = false; // one restart dialog (and one restart) at a time
const pendingFolders = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLI = path.join(ROOT, "dist", "cli.js");
// The daemon runs on this app's own binary as Node (ELECTRON_RUN_AS_NODE): no system Node needed.
const NODE = process.env.RUAH_NODE ?? process.execPath;
// A process running as Node opens an inspector on SIGUSR1 whatever the fuses say (they guard this
// main process only): the long-lived daemon turns that off (its own children inherit execArgv).
const NODE_ARGS = NODE === process.execPath ? ["--disable-sigusr1"] : [];

function log(line) {
  const text = line.endsWith("\n") ? line : `${line}\n`;
  if (IS_DEV) process.stderr.write(text);
  logStream?.write(text);
}

function openLog() {
  // Rotates itself past 5 MB, also while the app runs for days (CONTRACTS §15.5).
  logStream = desktop.openRotatingLog(LOG_FILE);
  logStream.write(`\n--- ${APP_NAME} ${VERSION} (${IS_DEV ? `dev, ${ROOT}` : "app"}) ${new Date().toISOString()} ---\n`);
}

// Without a repo the daemon starts in the launcher state: the viewer's start
// screen opens or creates a project (CONTRACTS §5).
function startDaemon(repoDir) {
  // No RUAH_AGENT: the daemon starts the saved default agent (Settings → Agents).
  const agentArgs = AGENT === "mock" ? ["--mock"] : AGENT !== undefined ? ["--agent", AGENT] : [];
  const repoArgs = repoDir === undefined ? [] : [repoDir];
  daemonReady = false;
  const child = spawn(
    NODE,
    [...NODE_ARGS, CLI, "serve", ...repoArgs, ...agentArgs, "--viewer", VIEWER_DIR, "--port", String(PORT)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        RUAH_PARENT_PID: String(process.pid),
        // Finder / Dock launches get launchd's bare environment: the daemon takes the login shell's (CONTRACTS §15.2).
        RUAH_LOGIN_ENV: "1",
      },
    },
  );
  daemon = child;
  // A bad RUAH_NODE (spawn failure) is an "error" event: without a handler it is an uncaught
  // exception in main, and `daemon` stayed set so waitForDaemon waited its full minute.
  daemon.on("error", (err) => {
    log(`[ruah] backend failed to start: ${err.message}`);
    if (daemon === child) daemon = null;
  });
  child.stdout.on("data", (c) => {
    if (IS_DEV) process.stdout.write(`[daemon] ${c}`);
    logStream?.write(c);
  });
  child.stderr.on("data", (c) => {
    if (IS_DEV) process.stderr.write(`[daemon] ${c}`);
    logStream?.write(c);
  });
  child.on("exit", (code, signal) => {
    if (daemon === child) {
      daemon = null;
      daemonReady = false;
    }
    log(`[ruah] backend exited (${code ?? signal})`);
    // Any exit we did not ask for (a crash, or a kill from outside) leaves a dead window: offer a restart.
    if (!quitting && daemonReadyOnce && daemon === null) void offerRestart(code ?? signal);
  });
}

function healthOnce() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function waitForDaemon(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (daemon === null) throw new Error("backend exited before becoming healthy");
    if (await healthOnce()) {
      daemonReady = true;
      daemonReadyOnce = true;
      return;
    }
    await sleep(100);
  }
  throw new Error(`backend did not become healthy within ${maxMs} ms`);
}

function stopDaemon() {
  quitting = true;
  if (daemon !== null && daemon.exitCode === null) daemon.kill("SIGTERM");
}

/** dialog.showMessageBox attached to the window when there is one. */
function messageBox(options) {
  return win !== null && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/** The backend died after it had been healthy and nothing is bringing it back. */
function backendDown() {
  return !quitting && daemonReadyOnce && daemon === null;
}

/**
 * One dialog at a time: Restart / Later (Esc) / Show Logs / Quit. A restart that dies
 * before it is healthy comes back to this same dialog (never a second one); folders that
 * arrived meanwhile open once it is up. "Later" leaves it down — the Dock icon asks again.
 */
async function offerRestart(reason) {
  if (restartOffered || !backendDown()) return;
  restartOffered = true;
  try {
    let why = `It exited unexpectedly (${reason}).`;
    for (;;) {
      const { response } = await messageBox({
        type: "warning",
        message: `${APP_NAME}'s backend stopped`,
        detail: `${why} Running agents were stopped; your projects and chats are saved.`,
        buttons: ["Restart", "Later", "Show Logs", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (quitting) return;
      if (response === 1) return;
      if (response === 2) {
        shell.showItemInFolder(LOG_FILE);
        continue;
      }
      if (response === 3) {
        app.quit();
        return;
      }
      try {
        // Back on the start screen (recent projects one click away); chats and maps are on disk.
        startDaemon(undefined);
        await waitForDaemon(60000);
        if (win !== null && !win.isDestroyed()) win.reload();
        await flushPendingFolders(); // open-file / second-instance folders that arrived while it was down
        return;
      } catch (err) {
        log(`[ruah] restart failed: ${err?.message ?? err}`);
        if (daemon !== null && daemon.exitCode === null) daemon.kill("SIGTERM");
        why = `It could not be restarted (${err?.message ?? err}).`;
      }
    }
  } finally {
    restartOffered = false;
  }
}

// ---------- opening folders (launch argument, `open -a`, second instance, menu) ----------

function postJson(pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BASE}${pathname}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (text.length < 65536) text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, json: { error: err.message } }));
    req.end(data);
  });
}

/**
 * An instance on a scratch RUAH_HOME asks before it opens a folder macOS handed it after
 * launch: `open -a`, Finder and the Dock pick the running app by bundle id, not by home
 * (desktop.confirmOpenFile). Resolves true to go ahead.
 */
async function confirmForeignFolder(target) {
  if (!desktop.confirmOpenFile({ env: process.env, launched: daemonReadyOnce })) return true;
  showWindow();
  const { response } = await messageBox({
    type: "question",
    message: `Open ${path.basename(target)} in this ${APP_NAME}?`,
    detail: `This ${APP_NAME} keeps its data in ${process.env.RUAH_HOME} (a separate instance). macOS sends folders opened with ${APP_NAME} to whichever copy is running, so this one may not be the one you meant. Opening maps the folder and writes architecture.json into it.\n\n${target}`,
    buttons: ["Open", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/** Opens `folder` as the current project (CONTRACTS §5.3 POST /api/projects/open) and brings the window up. */
async function openFolder(folder, source) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return;
  let target = folder;
  try {
    if (!fs.statSync(target).isDirectory()) target = path.dirname(target); // a file dropped on the Dock icon: its folder
  } catch {
    return;
  }
  if (source === "open-file" && !(await confirmForeignFolder(target))) {
    log(`[ruah] not opening ${target} (open-file, declined)`);
    return;
  }
  if (!daemonReady) {
    pendingFolders.push(target);
    if (backendDown()) void offerRestart("it is not running");
    return;
  }
  log(`[ruah] opening ${target} (${source})`);
  showWindow();
  const { status, json } = await postJson("/api/projects/open", { path: target });
  if (status !== 200) {
    const message = json !== null && typeof json === "object" && typeof json.error === "string" ? json.error : `HTTP ${status}`;
    void messageBox({ type: "warning", message: `Ruah could not open ${path.basename(target)}`, detail: message });
  }
}

async function flushPendingFolders() {
  const folder = pendingFolders.splice(0).pop(); // the last request wins
  if (folder !== undefined) await openFolder(folder, "queued");
}

async function pickAndOpenFolder() {
  const owner = win !== null && !win.isDestroyed() ? win : undefined;
  const options = { title: "Open a folder", buttonLabel: "Open", properties: ["openDirectory", "createDirectory"] };
  const result = owner !== undefined ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths.length > 0) await openFolder(result.filePaths[0], "menu");
}

// `open -a Ruah <dir>`, a folder dropped on the Dock icon, Finder "Open With".
// Registered before `ready`: at launch macOS delivers it before the app is up.
app.on("open-file", (event, file) => {
  event.preventDefault();
  void openFolder(file, "open-file");
});

// ---------- window ----------

function workAreas() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primaryDisplay.id);
  return [primaryDisplay, ...others].map((d) => d.workArea);
}

function saveWindowState() {
  if (win === null || win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  desktop.writeJson(WINDOW_STATE, { ...bounds, maximized: win.isMaximized() });
}

function createWindow() {
  const bounds = desktop.windowBounds(desktop.readJson(WINDOW_STATE), workAreas());
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: desktop.MIN_WIDTH,
    minHeight: desktop.MIN_HEIGHT,
    title: "Ruah",
    show: false,
    icon: APP_ICON, // Windows/Linux window + taskbar; macOS uses the bundle / Dock icon
    backgroundColor: "#26282b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DEVTOOLS,
      additionalArguments: [`--ruah-version=${VERSION}`],
    },
  });
  if (bounds.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  const loadStarted = Date.now();
  win.webContents.on("did-finish-load", () => {
    const contents = win?.webContents;
    if (contents === undefined) return;
    log(`[ruah] window loaded ${contents.getURL()} "${contents.getTitle()}" in ${Date.now() - loadStarted} ms`);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`[ruah] window failed to load ${url}: ${description} (${code})`);
  });
  // A crashed or killed renderer: reload the viewer rather than leave a blank window.
  win.webContents.on("render-process-gone", (_event, details) => {
    log(`[ruah] viewer process gone: ${details.reason} (${details.exitCode})`);
    if (!quitting && details.reason !== "clean-exit" && win !== null && !win.isDestroyed()) win.reload();
  });
  // The window only ever shows the daemon's viewer. Dropping a file (e.g. a screenshot from
  // Finder) outside the chat's drop zone makes Chromium navigate to that file://…, and a plain
  // link (agent Markdown, a cloud resource URL) would load an outside page that still gets
  // window.ruah from the preload: web links go to the default browser, everything else stays.
  win.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, BASE)) return;
    event.preventDefault();
    openInBrowser(url);
  });
  // target="_blank" links and window.open: never a child BrowserWindow (it would inherit the preload).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });

  // Downloads (e.g. Export → draw.io): always ask where to save, starting in
  // ~/Downloads with the suggested name. Without a save path Electron shows
  // this dialog; the options only set its defaults.
  win.webContents.session.on("will-download", (_event, item) => {
    const name = item.getFilename() || "download";
    const ext = path.extname(name).slice(1);
    item.setSaveDialogOptions({
      title: "Save export",
      defaultPath: path.join(app.getPath("downloads"), name),
      ...(ext === "drawio" ? { filters: [{ name: "draw.io diagram", extensions: ["drawio"] }] } : {}),
    });
  });

  for (const event of ["resized", "moved"]) win.on(event, saveWindowState);
  // macOS: closing the window hides it — the viewer stays connected, so agents
  // keep working and notifications still arrive; the Dock icon or ⌘-Tab brings
  // it back. ⌘Q quits for real.
  win.on("close", (event) => {
    saveWindowState();
    if (quitting || process.platform !== "darwin") return;
    event.preventDefault();
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => win?.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  return win.loadURL(BASE);
}

/** Shows the window, creating it when there is none (idempotent: `win` is set before it loads). */
function showWindow() {
  if (!daemonReady) return;
  if (win === null || win.isDestroyed()) {
    createWindow().catch((err) => log(`[ruah] window: ${err?.message ?? err}`));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- menu ----------

function installMenu() {
  const template = desktop.buildMenuTemplate({
    appName: APP_NAME,
    isDev: DEVTOOLS,
    actions: {
      openFolder: () => void pickAndOpenFolder(),
      openSettings: () => {
        showWindow();
        win?.webContents.send("ruah:menu-command", { command: "settings" });
      },
      openHelp: () => void shell.openExternal(HELP_URL),
      showLogs: () => shell.showItemInFolder(fs.existsSync(LOG_FILE) ? LOG_FILE : path.dirname(LOG_FILE)),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC (preload.cjs, CONTRACTS §5.4 / §13.3) ----------

// window.ruah (preload.cjs, CONTRACTS §5.4): native folder picker and
// "Reveal in Finder". Arguments from the renderer are validated here.
function registerIpc() {
  ipcMain.handle("ruah:pick-folder", async (event, opts) => {
    const title =
      opts !== null && typeof opts === "object" && typeof opts.title === "string" ? opts.title : "Choose a folder";
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title, buttonLabel: "Choose", properties: ["openDirectory", "createDirectory"] };
    const result = owner !== null ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.handle("ruah:reveal", (_event, target) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
  // Links clicked in the terminal: web pages only (never file:, custom schemes or app handlers).
  ipcMain.handle("ruah:open-external", async (_event, url) => {
    if (typeof url !== "string" || url.length > 8192) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    await shell.openExternal(parsed.toString());
    return true;
  });
}

// CONTRACTS §13.3: native notifications for background agent activity. The
// renderer decides when (its activity store knows the open project, the window
// focus and settings.json's `notifications`); main only shows them and routes
// a click back: focus the window, then "ruah:notification-click" to the renderer.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const shownNotifications = new Set(); // referenced until closed, or Electron may drop the click handler

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

function registerNotifications() {
  ipcMain.handle("ruah:notify", (event, opts) => {
    if (!Notification.isSupported() || opts === null || typeof opts !== "object") return false;
    const title = cleanText(opts.title, 120);
    const body = cleanText(opts.body, 300);
    const projectId = typeof opts.projectId === "string" && ID.test(opts.projectId) ? opts.projectId : null;
    const chatId = typeof opts.chatId === "string" && ID.test(opts.chatId) ? opts.chatId : null;
    const root = typeof opts.projectRoot === "string" && path.isAbsolute(opts.projectRoot) ? opts.projectRoot.slice(0, 4096) : null;
    if (title.length === 0 || projectId === null) return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const note = new Notification({ title, body, silent: opts.silent === true });
    shownNotifications.add(note);
    const forget = () => shownNotifications.delete(note);
    note.on("close", forget);
    note.on("click", () => {
      forget();
      const target = owner !== null && !owner.isDestroyed() ? owner : win;
      if (target === null || target.isDestroyed()) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      app.focus({ steal: true });
      target.webContents.send("ruah:notification-click", { projectId, chatId, projectRoot: root });
    });
    note.show();
    return true;
  });
}

function openInBrowser(url) {
  const web = webUrl(url);
  if (web !== null) shell.openExternal(web).catch(() => {});
}

// Settings → Features & behaviour: ⌥Space anywhere focuses Ruah and opens the launcher. Off by
// default; registered only while the renderer asks for it (and released on quit). If another app
// already owns the accelerator, register() fails and the renderer is told (false).
const LAUNCHER_ACCELERATOR = "Alt+Space";
let launcherShortcutOn = false;

function registerLauncherShortcut() {
  ipcMain.handle("ruah:launcher-shortcut", (_event, on) => {
    const want = on === true;
    if (want === launcherShortcutOn) return launcherShortcutOn;
    if (!want) {
      globalShortcut.unregister(LAUNCHER_ACCELERATOR);
      launcherShortcutOn = false;
      return false;
    }
    try {
      launcherShortcutOn = globalShortcut.register(LAUNCHER_ACCELERATOR, () => {
        if (win === null || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show(); // also brings back a window hidden by ⌘W (§15.5)
        win.focus();
        app.focus({ steal: true });
        win.webContents.send("ruah:launcher");
      });
    } catch {
      launcherShortcutOn = false;
    }
    return launcherShortcutOn;
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}

// ---------- startup ----------

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  openLog();
  registerIpc();
  registerNotifications();
  registerLauncherShortcut();
  installMenu();
  // Never attach to whatever already listens on the port (a leftover daemon
  // would show another state): start our own on a free port instead.
  if (!(await portFree(PORT))) {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    log(`[ruah] port ${PREFERRED_PORT} is busy; using ${PORT}`);
  }
  // A folder from `open -a Ruah <dir>` at launch arrives as open-file, possibly before this point.
  const launchFolder = pendingFolders.length > 0 ? pendingFolders.splice(0).pop() : startupFolder;
  startDaemon(launchFolder);
  await waitForDaemon(60000); // the agent starts in the background once a project is open
  showWindow();
  await flushPendingFolders(); // open-file / second-instance folders that arrived while the daemon was starting
}

if (!primary) {
  // Another Ruah owns this profile: it received our folder through `second-instance`. Say so —
  // from a terminal (`pnpm app`, `ruah app`) a silent exit looks like a crash.
  const owner = desktop.lockOwner(app.getPath("userData"));
  process.stderr.write(
    `[ruah] ${APP_NAME} is already running with this profile (${app.getPath("userData")}${owner !== undefined ? `, pid ${owner.pid}` : ""}); ` +
      `${startupFolder !== undefined ? `handed ${startupFolder} to it` : "brought it to the front"}.\n`,
  );
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory, additionalData) => {
    // Our own second instance says which folder it was asked for (null: none) — trust that over
    // re-parsing its argv, which Chromium may have extended.
    const folder = desktop.secondInstanceFolder(additionalData, argv, { isPackaged: app.isPackaged, cwd: workingDirectory });
    if (folder !== undefined) void openFolder(folder, "second instance");
    else showWindow();
  });

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: VERSION,
    version: `Electron ${process.versions.electron}`,
    copyright: "© 2026 Ruah",
    iconPath: APP_ICON,
  });

  app.whenReady().then(() => {
    // The Ruah mark instead of Electron's default icon (dev runs use the stock
    // Electron.app bundle; packaged builds carry icon.icns).
    if (IS_DEV && process.platform === "darwin" && app.dock) app.dock.setIcon(APP_ICON);
    main().catch((err) => {
      log(`[ruah] ${err?.message ?? err}`);
      stopDaemon();
      dialog.showErrorBox("Ruah could not start", `${err?.message ?? err}\n\nDetails: ${LOG_FILE}`);
      app.exit(1);
    });
  });

  // Dock icon clicked (or the app re-activated) with the window hidden or closed; a backend
  // left down with "Later" is offered again.
  app.on("activate", () => {
    if (backendDown()) void offerRestart("it is not running");
    else showWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin" && !quitting) return; // stays in the Dock; the daemon keeps running
    stopDaemon();
    app.quit();
  });

  // Cmd+Q, app menu Quit, logout: stop the daemon too (it would otherwise keep
  // the port). The daemon also exits by itself if this process disappears
  // without running these handlers (RUAH_PARENT_PID, see run-serve.ts).
  app.on("before-quit", () => {
    quitting = true;
    saveWindowState();
    stopDaemon();
  });
  process.on("exit", stopDaemon);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      quitting = true;
      stopDaemon();
      app.exit(0);
    });
  }
}
