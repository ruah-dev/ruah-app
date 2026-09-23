const { contextBridge, ipcRenderer } = require("electron");

const version = process.env.npm_package_version ?? "0.1.0";

// CONTRACTS §5.4: the desktop bridge. contextIsolation stays on; the renderer
// only gets these functions, which forward to ipcMain handlers in main.cjs.
contextBridge.exposeInMainWorld("ruah", {
  version,
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickFolder: (opts) =>
    ipcRenderer.invoke("ruah:pick-folder", opts !== null && typeof opts === "object" && typeof opts.title === "string" ? { title: opts.title } : {}),
  /** Shows the file or folder in Finder. */
  revealInFinder: (target) => {
    if (typeof target === "string") void ipcRenderer.invoke("ruah:reveal", target);
  },
});

// Kept for viewers built before window.ruah existed.
contextBridge.exposeInMainWorld("archmap", { version });
