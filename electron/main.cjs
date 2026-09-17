const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

let daemon = null;
let win = null;

function startDaemon(repoDir) {
  const entry = path.join(__dirname, "..", "dist", "cli.js");
  daemon = spawn(process.execPath, [entry, "serve", repoDir, "--mock", "--port", "4177"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (c) => process.stdout.write(`[daemon] ${c}`));
  daemon.stderr.on("data", (c) => process.stderr.write(`[daemon] ${c}`));
}

function createWindow(repoDir) {
  startDaemon(repoDir);
  win = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  const url = "http://127.0.0.1:4177";
  win.loadURL(url);
}

app.whenReady().then(() => {
  const repoDir = process.argv[2] ?? "/Users/petre/Projects/personal-projects/whz-arhy/archmap-wp-b/test/golden";
  createWindow(repoDir);
});
app.on("window-all-closed", () => {
  if (daemon) daemon.kill();
  app.quit();
});
