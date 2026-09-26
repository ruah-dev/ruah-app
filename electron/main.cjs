const { app, BrowserWindow, Notification, dialog, globalShortcut, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const net = require("node:net");
const { sameOrigin, webUrl } = require("./links.cjs");

// 4177 when it is free (keeps the viewer's saved preferences, which are per
// origin); otherwise any free port, so a second window or a leftover process
// never blocks the app. RUAH_PORT forces a port.
const PREFERRED_PORT = Number.parseInt(process.env.RUAH_PORT ?? "4177", 10);
let PORT = PREFERRED_PORT;
let BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");
// Ruah brand mark (from ruah-website public/brand/ruah-icon.svg, on the macOS
// 1024 icon grid); icon.icns is there for packaging.
const APP_ICON = path.join(__dirname, "assets", "icon.png");
// RUAH_AGENT picks the initial agent (unset: the saved default agent, else "claude"):
// "cursor", "grok", "kiro", "opencode", "acp" (Claude through the ACP adapter) or "mock"
// (scripted, no agent). The viewer can switch agents at runtime.
const AGENT = process.env.RUAH_AGENT;
// The built viewer (`pnpm ui:build` → viewer/); RUAH_VIEWER overrides it.
const VIEWER_DIR = process.env.RUAH_VIEWER ?? path.join(ROOT, "viewer");
// Developing Ruah (`pnpm dev`, scripts/dev.ts): load the viewer from the Vite dev server (hot
// reload) and use the daemon the dev script runs under a watcher instead of starting one.
const VIEWER_URL = process.env.RUAH_VIEWER_URL;
const EXTERNAL_DAEMON = process.env.RUAH_DAEMON_URL;

let daemon = null;
let win = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLI = path.join(ROOT, "dist", "cli.js");
const NODE = process.env.RUAH_NODE ?? process.execPath;
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

// Without a repo the daemon starts in the launcher state: the viewer's start
// screen opens or creates a project (CONTRACTS §5), so there is no folder
// picker or scan before startup any more.
function startDaemon(repoDir) {
  // No RUAH_AGENT: the daemon starts the saved default agent (Settings → Agents).
  const agentArgs = AGENT === "mock" ? ["--mock"] : AGENT !== undefined ? ["--agent", AGENT] : [];
  const repoArgs = repoDir === undefined ? [] : [repoDir];
  daemon = spawn(
    NODE,
    [CLI, "serve", ...repoArgs, ...agentArgs, "--viewer", VIEWER_DIR, "--port", String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...NODE_ENV, RUAH_PARENT_PID: String(process.pid) } },
  );
  daemon.stdout.on("data", (c) => process.stdout.write(`[daemon] ${c}`));
  daemon.stderr.on("data", (c) => process.stderr.write(`[daemon] ${c}`));
  // A bad RUAH_NODE (spawn failure) is an "error" event: without a handler it is an uncaught
  // exception in main, and `daemon` stayed set so waitForDaemon waited its full minute.
  daemon.on("error", (err) => {
    process.stderr.write(`[ruah] backend failed to start: ${err.message}\n`);
    daemon = null;
  });
  daemon.on("exit", (code, signal) => {
    daemon = null;
    // Killed by a signal (OOM, a native crash) has code null: say so too, not only non-zero codes.
    const failed = (code !== null && code !== 0) || (code === null && signal !== null && !quitting);
    if (failed && win !== null && !win.isDestroyed()) {
      const why = code !== null ? `with code ${code}` : `on ${signal}`;
      win.webContents.executeJavaScript(
        `document.body.innerHTML = '<p style="font:13px ui-monospace;padding:2rem">backend exited ${why}</p>'`,
      ).catch(() => {});
    }
  });
}

function healthOnce() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForDaemon(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (daemon === null && EXTERNAL_DAEMON === undefined) throw new Error("backend exited before becoming healthy");
    if (await healthOnce()) return;
    await sleep(100);
  }
  throw new Error(`backend did not become healthy within ${maxMs} ms`);
}

function repoFromArgv(argv) {
  // Dev launch (`electron . [repo]`): the app path (argv[2], usually ".") is
  // followed by user args. Packaged launches pass user args after "--".
  // "." (the app itself) never counts as the repo.
  const sep = argv.indexOf("--");
  const candidates = (sep === -1 ? argv.slice(2) : argv.slice(sep + 1))
    .filter((a) => !a.startsWith("--"));
  const found = candidates.find(
    (a) => a !== "." && fs.existsSync(a) && fs.statSync(a).isDirectory(),
  );
  return found === undefined ? undefined : path.resolve(found);
}

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
        win.show();
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

// CONTRACTS §15.6: the live preview shows pages that refuse iframes in a <webview>. Every
// webview is locked down here: no preload, no Node, sandboxed, its own session
// (persist:ruah-preview), http(s) only; its popups open in the default browser. Frames and
// webviews get no camera / microphone / location / notifications (Electron would grant them
// without asking); the viewer itself is unaffected.
const PREVIEW_PARTITION = "persist:ruah-preview";
const FRAME_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

function registerPreviewGuards() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      params.partition = PREVIEW_PARTITION;
      if (webUrl(params.src) === null) event.preventDefault();
    });
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        openInBrowser(url);
        return { action: "deny" };
      });
      contents.on("will-navigate", (event, url) => {
        if (webUrl(url) === null) event.preventDefault();
      });
    }
  });
  const viewerOrigin = () => new URL(VIEWER_URL ?? BASE).origin;
  const guard = (ses, isPreview) => {
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      let origin = "";
      try {
        origin = new URL(details.requestingUrl).origin;
      } catch {
        origin = "";
      }
      callback(!isPreview && origin === viewerOrigin() ? true : FRAME_PERMISSIONS.has(permission));
    });
  };
  guard(session.defaultSession, false);
  guard(session.fromPartition(PREVIEW_PARTITION), true);
}

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

let quitting = false;

function stopDaemon() {
  quitting = true;
  if (daemon !== null && daemon.exitCode === null) daemon.kill("SIGTERM");
}

async function main() {
  const repoDir = process.env.RUAH_REPO ?? repoFromArgv(process.argv);
  registerIpc();
  registerNotifications();
  registerLauncherShortcut();
  registerPreviewGuards();
  if (EXTERNAL_DAEMON !== undefined) {
    // `pnpm dev`: the dev script runs (and restarts) the daemon; the viewer reconnects by itself.
    BASE = EXTERNAL_DAEMON.replace(/\/+$/, "");
  } else {
    // Never attach to whatever already listens on the port (a leftover daemon
    // would show another state): start our own on a free port instead.
    if (!(await portFree(PORT))) {
      PORT = await freePort();
      BASE = `http://127.0.0.1:${PORT}`;
      process.stderr.write(`[ruah] port ${PREFERRED_PORT} is busy; using ${PORT}\n`);
    }
    startDaemon(repoDir);
  }
  await waitForDaemon(60000); // the agent starts in the background once a project is open
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Ruah",
    icon: APP_ICON, // Windows/Linux window + taskbar; macOS uses the Dock icon below
    backgroundColor: "#26282b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // §15.6: the live preview's fallback for pages that refuse iframes (locked down in registerPreviewGuards).
      webviewTag: true,
    },
  });
  // The window only ever shows the daemon's viewer. Dropping a file (e.g. a screenshot from
  // Finder) outside the chat's drop zone makes Chromium navigate to that file://…, and a plain
  // link (agent Markdown, a cloud resource URL) would load an outside page that still gets
  // window.ruah from the preload: web links go to the default browser, everything else stays.
  win.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, BASE)) return;
    // `pnpm dev` serves the viewer from the Vite dev server (RUAH_VIEWER_URL), not the daemon.
    if (VIEWER_URL !== undefined && sameOrigin(url, VIEWER_URL)) return;
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
  await win.loadURL(VIEWER_URL ?? BASE);
}

app.setName("Ruah");
app.setAboutPanelOptions({
  applicationName: "Ruah",
  applicationVersion: require(path.join(ROOT, "package.json")).version,
  iconPath: APP_ICON,
});

app.whenReady().then(() => {
  // The Ruah mark instead of Electron's default icon (dev runs use the stock
  // Electron.app bundle, so set it at runtime; packaged builds use icon.icns).
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(APP_ICON);
  main().catch((err) => {
    process.stderr.write(`[ruah] ${err?.message ?? err}\n`);
    if (daemon) daemon.kill();
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  stopDaemon();
  app.quit();
});

// Cmd+Q, app menu Quit, logout: stop the daemon too (it would otherwise keep
// the port). The daemon also exits by itself if this process disappears
// without running these handlers (RUAH_PARENT_PID, see run-serve.ts).
app.on("before-quit", stopDaemon);
process.on("exit", stopDaemon);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopDaemon();
    app.exit(0);
  });
}
