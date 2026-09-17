const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("archmap", {
  version: process.env.npm_package_version ?? "0.1.0",
});
