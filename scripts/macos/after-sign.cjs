// scripts/macos/after-sign.cjs — electron-builder afterSign: prove the signed app
// can run its daemon before it goes into the .dmg. The app binary, as Node
// (ELECTRON_RUN_AS_NODE, exactly how main.cjs starts the daemon):
//   1. runs dist/cli.js (the daemon's entry) — `--version`;
//   2. loads node-pty and reads a real pty's output (native ABI + spawn-helper);
//   3. resolves Claude's bundled native CLI (still signed by Anthropic) and runs `--version`.
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
  console.log(`  • after-sign  daemon ${version} runs on the app binary (${pty}); node-pty ok; claude ${claudeVersion} (team ${claudeSigner})`);
};
