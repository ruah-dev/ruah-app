const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const net = require("node:net");

// 4177 when it is free (keeps the viewer's saved preferences, which are per
// origin); otherwise any free port, so a second window or a leftover process
// never blocks the app. RUAH_PORT forces a port.
const PREFERRED_PORT = Number.parseInt(process.env.RUAH_PORT ?? "4177", 10);
let PORT = PREFERRED_PORT;
let BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");
// ARCHMAP_AGENT picks the initial agent: "claude" (Claude Agent SDK, default),
// "cursor", "grok", "kiro", "opencode", "acp" (Claude through the ACP adapter) or "mock"
// (scripted, no agent). The viewer can switch agents at runtime.
const AGENT = process.env.ARCHMAP_AGENT ?? "claude";
// The Lovable viewer build (docs/PLAN.md: `viewer/`) when present, else the
// placeholder renderer.
const VIEWER_DIR =
  process.env.ARCHMAP_VIEWER ??
  (fs.existsSync(path.join(ROOT, "viewer", "index.html"))
    ? path.join(ROOT, "viewer")
    : path.join(ROOT, "renderer", "dist"));

let daemon = null;
let win = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLI = path.join(ROOT, "dist", "cli.js");
const NODE = process.env.ARCHMAP_NODE ?? process.execPath;
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

// Without a repo the daemon starts in the launcher state: the viewer's start
// screen opens or creates a project (CONTRACTS §5), so there is no folder
// picker or scan before startup any more.
function startDaemon(repoDir) {
  const agentArgs = AGENT === "mock" ? ["--mock"] : ["--agent", AGENT];
  const repoArgs = repoDir === undefined ? [] : [repoDir];
  daemon = spawn(
    NODE,
    [CLI, "serve", ...repoArgs, ...agentArgs, "--viewer", VIEWER_DIR, "--port", String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...NODE_ENV, RUAH_PARENT_PID: String(process.pid) } },
  );
  daemon.stdout.on("data", (c) => process.stdout.write(`[daemon] ${c}`));
  daemon.stderr.on("data", (c) => process.stderr.write(`[daemon] ${c}`));
  daemon.on("exit", (code) => {
    daemon = null;
    if (code !== null && code !== 0 && win !== null && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        `document.body.innerHTML = '<p style="font:13px ui-monospace;padding:2rem">backend exited with code ${code}</p>'`,
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
    if (daemon === null) throw new Error("backend exited before becoming healthy");
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

function stopDaemon() {
  if (daemon !== null && daemon.exitCode === null) daemon.kill("SIGTERM");
}

async function main() {
  const repoDir = process.env.ARCHMAP_REPO ?? repoFromArgv(process.argv);
  registerIpc();
  // Never attach to whatever already listens on the port (a leftover daemon
  // would show another state): start our own on a free port instead.
  if (!(await portFree(PORT))) {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    process.stderr.write(`[ruah] port ${PREFERRED_PORT} is busy; using ${PORT}\n`);
  }
  startDaemon(repoDir);
  await waitForDaemon(60000); // the agent starts in the background once a project is open
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Ruah",
    backgroundColor: "#fcfcfc",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(BASE);
}

app.setName("Ruah");

app.whenReady().then(() => {
  main().catch((err) => {
    process.stderr.write(`[archmap] ${err?.message ?? err}\n`);
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
