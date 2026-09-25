const { contextBridge, ipcRenderer } = require("electron");

// main.cjs passes the app version (package.json) as an argument; `pnpm desktop` also has it in env.
const versionArg = process.argv.find((a) => typeof a === "string" && a.startsWith("--ruah-version="));
const version = versionArg !== undefined ? versionArg.slice("--ruah-version=".length) : (process.env.npm_package_version ?? "0.0.0");

// CONTRACTS §15.4: application-menu commands main.cjs forwards to the page. A
// command nobody subscribed to gets a default: "settings" routes to /settings.
const menuListeners = new Set();
ipcRenderer.on("ruah:menu-command", (_event, payload) => {
  const command = payload !== null && typeof payload === "object" && typeof payload.command === "string" ? payload.command : "";
  if (command.length === 0) return;
  if (menuListeners.size > 0) {
    for (const listener of menuListeners) {
      try {
        listener(command);
      } catch {
        // one broken subscriber must not stop the others
      }
    }
    return;
  }
  if (command === "settings" && window.location.pathname !== "/settings") {
    // The router listens to popstate (TanStack Router's browser history).
    window.history.pushState(window.history.state, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }
});

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
  /** Called with the command ("settings") when the user picks it in the application menu; returns an unsubscribe function. Subscribing replaces the default handling. */
  onMenuCommand: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (command) => callback(command);
    menuListeners.add(listener);
    return () => menuListeners.delete(listener);
  },
  /** Called with { projectId, chatId, projectRoot } when the user clicks a notification; returns an unsubscribe function. */
  onNotificationClick: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("ruah:notification-click", listener);
    return () => ipcRenderer.removeListener("ruah:notification-click", listener);
  },
});
