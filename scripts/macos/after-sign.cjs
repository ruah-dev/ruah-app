// scripts/macos/after-sign.cjs — electron-builder afterSign: prove the signed app
// can run its daemon before it goes into the .dmg. The app binary, as Node
// (ELECTRON_RUN_AS_NODE, exactly how main.cjs starts the daemon):
//   1. runs dist/cli.js (the daemon's entry) — `--version`;
//   2. loads node-pty and reads a real pty's output (native ABI + spawn-helper);
//   3. resolves Claude's bundled native CLI (still signed by Anthropic) and runs `--version`;
//   4. has the fuses electron-builder.config.cjs asks for (read from the signed framework),
//      ignores NODE_OPTIONS in practice, and accepts the daemon's --disable-sigusr1.
// Any failure stops `pnpm dist`.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

const PTY_PROBE = `
const pty = require("node-pty");
const term = pty.spawn("/bin/sh", ["-c", "printf pty-ok"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });
let out = "";
term.onData((d) => { out += d; });
term.onExit(({ exitCode }) => {
  if (!out.includes("pty-ok") || exitCode !== 0) { console.error("pty output: " + JSON.stringify(out) + " exit " + exitCode); process.exit(1); }
  console.log("node " + process.versions.node + ", modules " + process.versions.modules);
  process.exit(0);
});
setTimeout(() => { console.error("pty timed out"); process.exit(1); }, 10000);
`;

const CLAUDE_PROBE = `
const { createRequire } = require("node:module");
const req = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
console.log(req.resolve("@anthropic-ai/claude-agent-sdk-" + process.platform + "-" + process.arch + "/claude"));
`;

/** The fuse states electron-builder.config.cjs sets (electronFuses), by @electron/fuses option name. */
const EXPECTED_FUSES = {
  RunAsNode: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  GrantFileProtocolExtraPrivileges: false,
};

/** @electron/fuses as electron-builder itself loads it (a dependency of app-builder-lib, not ours). */
function loadFuses() {
  const lib = require.resolve("app-builder-lib", { paths: [require.resolve("electron-builder")] });
  return require(require.resolve("@electron/fuses", { paths: [lib] }));
}

/**
 * The signed binary has the fuses the config asks for, and they do what the daemon relies on.
 * (EnableNodeCliInspectArguments guards the app's main process only: a process running as
 * Node still takes --inspect, and SIGUSR1 — which main.cjs turns off for the daemon with
 * --disable-sigusr1.)
 */
async function checkFuses(binary, env, cwd) {
  const { getCurrentFuseWire, FuseV1Options } = loadFuses();
  const wire = await getCurrentFuseWire(binary);
  const ON = "1".charCodeAt(0);
  const OFF = "0".charCodeAt(0);
  for (const [name, on] of Object.entries(EXPECTED_FUSES)) {
    const state = wire[FuseV1Options[name]];
    if (state !== (on ? ON : OFF)) {
      throw new Error(`after-sign: fuse ${name} is ${state === ON ? "on" : state === OFF ? "off" : "missing"}, expected ${on ? "on" : "off"}`);
    }
  }
  const options = { cwd, encoding: "utf8", timeout: 30_000 };
  const nodeOptions = spawnSync(binary, ["-e", "process.stdout.write('ran')"], {
    ...options,
    env: { ...env, NODE_OPTIONS: "--require /nonexistent/ruah-fuse-probe.js" },
  });
  if (nodeOptions.status !== 0 || nodeOptions.stdout !== "ran") {
    throw new Error(`after-sign: the app binary, as Node, honours NODE_OPTIONS: ${nodeOptions.stderr.trim()}`);
  }
  const sigusr1 = spawnSync(binary, ["--disable-sigusr1", "-e", "process.stdout.write('ran')"], { ...options, env });
  if (sigusr1.status !== 0 || sigusr1.stdout !== "ran") {
    throw new Error(`after-sign: the app binary, as Node, rejects --disable-sigusr1 (the daemon starts with it): ${sigusr1.stderr.trim()}`);
  }
  return "fuses ok (RunAsNode on; NODE_OPTIONS, --inspect, file:// privileges off)";
}

exports.checkFuses = checkFuses;

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const binary = path.join(bundle, "Contents", "MacOS", context.packager.appInfo.productFilename);
  const appRoot = path.join(bundle, "Contents", "Resources", "app");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;

  const version = run(binary, [path.join(appRoot, "dist", "cli.js"), "--version"], { env, cwd: appRoot });
  const pty = run(binary, ["-e", PTY_PROBE], { env, cwd: appRoot });
  const claude = run(binary, ["-e", CLAUDE_PROBE], { env, cwd: appRoot });
  const fuses = await checkFuses(binary, env, appRoot);
  // A throwaway HOME: `claude --version` must not touch the builder's ~/.claude.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ruah-dist-"));
  let claudeVersion;
  try {
    claudeVersion = run(claude, ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: home } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const verify = spawnSync("codesign", ["--verify", "--strict", claude], { encoding: "utf8" });
  if (verify.status !== 0) throw new Error(`after-sign: Claude's native CLI has an invalid signature: ${verify.stderr.trim()}`);
  const info = spawnSync("codesign", ["-dv", claude], { encoding: "utf8" });
  const claudeSigner = /TeamIdentifier=(\S+)/.exec(`${info.stdout}${info.stderr}`)?.[1] ?? "none";
  console.log(`  • after-sign  daemon ${version} runs on the app binary (${pty}); node-pty ok; claude ${claudeVersion} (team ${claudeSigner}); ${fuses}`);
};
