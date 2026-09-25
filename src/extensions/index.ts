// src/extensions/index.ts — the extensions library (CONTRACTS §15): skills,
// MCP servers, Kiro powers, plugins and rules for the agents Ruah runs.
// Standalone: no daemon needed (`ruah app ext …`); the daemon serves it at
// /api/extensions and injects enabled extensions when agent sessions start.
export { ExtensionsService, defaultLaunch, projectRefFor, type ExtensionsServiceOptions, type ProjectRef } from "./service.js";
export { ExtensionsStore } from "./store.js";
export { handleExtensionsRequest } from "./http.js";
export { runExt } from "./cli.js";
export { discoverAgents } from "./discover.js";
export { featuredCatalog, featuredEntry } from "./featured.js";
export { inspectPath } from "./inspect.js";
export { resolveSession, type ResolvedSession } from "./resolve.js";
export { SUPPORT, supportFor, supportMatrix, withPluginDirs } from "./agents.js";
export { ExtensionError, extensionAgentFor } from "./model.js";
