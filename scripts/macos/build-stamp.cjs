// scripts/macos/build-stamp.cjs — which commit `pnpm dist` / `pnpm dist:app` packages, written into
// the app's package.json as `ruahBuild` (electron-builder extraMetadata). The installed app's daemon
// compares it with the checkout's branch to find updates (src/desktop/self-update.ts).
//
// repo: the main checkout, also when building from a linked worktree (the updater builds in one);
// RUAH_BUILD_REPO / RUAH_BUILD_REF override. dirty: the tree had uncommitted changes — the app
// then holds more than `commit`, and a newer commit is still an update. Outside git: undefined.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function buildStamp(cwd = process.cwd(), env = process.env) {
  try {
    const commit = git(cwd, ["rev-parse", "HEAD"]);
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const repo = env.RUAH_BUILD_REPO?.trim() || path.dirname(common);
    const ref = env.RUAH_BUILD_REF?.trim() || "main";
    const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
    return { commit, repo, ref, dirty, builtAt: new Date().toISOString() };
  } catch {
    return undefined;
  }
}

module.exports = { buildStamp };
