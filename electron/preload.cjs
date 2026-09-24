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
  /** Opens an http(s) URL in the default browser (terminal links; CONTRACTS §7.5). */
  openExternal: (url) => {
    if (typeof url === "string") void ipcRenderer.invoke("ruah:open-external", url);
  },
  /** Shows an OS notification (CONTRACTS §13.3); resolves false when not shown. */
  notify: (opts) =>
    opts !== null && typeof opts === "object"
      ? ipcRenderer.invoke("ruah:notify", {
          title: opts.title,
          body: opts.body,
          projectId: opts.projectId,
          chatId: opts.chatId,
          projectRoot: opts.projectRoot,
          silent: opts.silent === true,
        })
      : Promise.resolve(false),
  /** Called with { projectId, chatId, projectRoot } when the user clicks a notification; returns an unsubscribe function. */
  onNotificationClick: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("ruah:notification-click", listener);
    return () => ipcRenderer.removeListener("ruah:notification-click", listener);
  },
});
