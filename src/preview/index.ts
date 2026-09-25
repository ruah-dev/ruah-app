// Live preview of a project's dev server (CONTRACTS §15) — a standalone library:
// detection (detect.ts), the remembered choice (config.ts), URL discovery
// (url.ts), probes (probe.ts), runners (runner.ts: PTY / child process), the
// built-in static server with live reload (static-server.ts), the process
// manager (manager.ts), the daemon's HTTP endpoints (http.ts) and the
// `ruah app preview` CLI (cli.ts). Nothing here needs the daemon.
export { detectPreview, frameworkOf, packageManagerFor, selectCandidate, candidateDirs, composePorts, onPath, runScript, type DetectOptions, type PackageManager } from "./detect.js";
export { readPreviewFile, writePreviewChoice, formatPreviewFile, previewFileOf, PREVIEW_FILE, PreviewConfigError, type PreviewChoicePatch } from "./config.js";
export { findUrls, stripAnsi, LineSplitter, crashReason, localHost, type UrlHit } from "./url.js";
export { isPortOpen, findFreePort, ephemeralPort, checkHttp, framingFromHeaders, type Framing, type HttpCheck } from "./probe.js";
export { PtyRunner, ProcessRunner, shellCommand, type Runner, type RunSpec, type RunningProcess, type RunnerEvents } from "./runner.js";
export { startStaticServer, injectLiveReload, resolveStaticPath, LIVE_PATH, type StaticServer } from "./static-server.js";
export { PreviewManager, PreviewError, DEFAULT_PREVIEW_IDLE_MS, type PreviewManagerOptions, type PreviewProject, type PreviewTiming } from "./manager.js";
export { readShellEnv, previewEnv, parseEnvBlock } from "./shell-env.js";
