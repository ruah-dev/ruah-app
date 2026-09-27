// The installed app updates itself from its checkout (src/desktop/self-update.ts): the build stamp,
// finding a new commit on the branch, and the script that swaps the bundle once the app has quit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SWAP_SCRIPT, SelfUpdater, bundleOf, isUpdate, readBuildInfo } from "../src/desktop/self-update.js";

const require = createRequire(import.meta.url);
const { buildStamp } = require("../scripts/macos/build-stamp.cjs") as {
  buildStamp: (cwd: string, env?: NodeJS.ProcessEnv) => { commit: string; repo: string; ref: string; dirty: boolean } | undefined;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function repoWithCommits(n: number): { repo: string; commits: string[] } {
  const repo = mkdtempSync(path.join(tmpdir(), "ruah-update-"));
  git(repo, "init", "-q", "-b", "main");
  const commits: string[] = [];
  for (let i = 0; i < n; i += 1) {
    writeFileSync(path.join(repo, "f.txt"), `${i}\n`);
    git(repo, "add", "f.txt");
    git(repo, "commit", "-q", "-m", `change ${i}`);
    commits.push(git(repo, "rev-parse", "HEAD"));
  }
  return { repo, commits };
}

describe("build stamp", () => {
  it("records the commit, the main checkout, the branch and whether the tree was dirty", () => {
    const { repo, commits } = repoWithCommits(1);
    expect(buildStamp(repo)).toMatchObject({ commit: commits[0], repo: execFileSync("realpath", [repo], { encoding: "utf8" }).trim(), ref: "main", dirty: false });
    writeFileSync(path.join(repo, "f.txt"), "edited\n");
    expect(buildStamp(repo)?.dirty).toBe(true);
    expect(buildStamp(repo, { RUAH_BUILD_REF: "dev" })?.ref).toBe("dev");
  });

  it("is undefined outside git", () => {
    expect(buildStamp(mkdtempSync(path.join(tmpdir(), "ruah-nogit-")))).toBeUndefined();
  });
});

describe("reading the stamp", () => {
  it("takes a valid ruahBuild and rejects anything else", () => {
    expect(readBuildInfo({ ruahBuild: { commit: "abc1234", repo: "/r" } })).toMatchObject({ commit: "abc1234", repo: "/r", ref: "main", dirty: false });
    expect(readBuildInfo({})).toBeUndefined();
    expect(readBuildInfo({ ruahBuild: { commit: "not a sha", repo: "/r" } })).toBeUndefined();
    expect(readBuildInfo({ ruahBuild: { commit: "abc1234" } })).toBeUndefined();
  });

  it("finds the bundle of a packaged executable only", () => {
    expect(bundleOf("/Applications/Ruah.app/Contents/MacOS/Ruah")).toBe("/Applications/Ruah.app");
    expect(bundleOf("/usr/local/bin/node")).toBeUndefined();
  });

  it("another commit is an update, the same one is not", () => {
    expect(isUpdate("a", "b")).toBe(true);
    expect(isUpdate("a", "a")).toBe(false);
    expect(isUpdate("a", undefined)).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("SelfUpdater", () => {
  it("is off without a stamp or outside a packaged app", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ruah-home-"));
    expect(new SelfUpdater({ info: undefined, bundle: "/Applications/Ruah.app", home }).snapshot()).toMatchObject({ phase: "unsupported" });
    expect(new SelfUpdater({ info: { commit: "abc1234", repo: "/r", ref: "main", dirty: false, builtAt: "" }, bundle: undefined, home }).snapshot()).toMatchObject({ phase: "unsupported" });
  });

  it("finds new commits on the branch and how many", async () => {
    const { repo, commits } = repoWithCommits(3);
    const home = mkdtempSync(path.join(tmpdir(), "ruah-home-"));
    const old = new SelfUpdater({ info: { commit: commits[0]!, repo, ref: "main", dirty: false, builtAt: "" }, bundle: "/Applications/Ruah.app", home, auto: false });
    expect(await old.check()).toMatchObject({ phase: "available", latest: commits[2], behind: 2, subject: "change 2" });
    const fresh = new SelfUpdater({ info: { commit: commits[2]!, repo, ref: "main", dirty: false, builtAt: "" }, bundle: "/Applications/Ruah.app", home, auto: false });
    expect(await fresh.check()).toMatchObject({ phase: "current", behind: 0 });
  });

  it("the swap script replaces the bundle with the staged one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ruah-swap-"));
    const target = path.join(dir, "Ruah.app");
    const staged = path.join(dir, "staged", "Ruah.app");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "v"), "old");
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(staged, "v"), "new");
    const script = path.join(dir, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    execFileSync("/bin/sh", [script, target, staged, "", "0"], { encoding: "utf8" });
    expect(readFileSync(path.join(target, "v"), "utf8")).toBe("new");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${target}.previous`)).toBe(false);
  });

  it("the swap script keeps the app when nothing is staged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ruah-swap-"));
    const target = path.join(dir, "Ruah.app");
    mkdirSync(target);
    writeFileSync(path.join(dir, "swap.sh"), SWAP_SCRIPT, { mode: 0o755 });
    expect(() => execFileSync("/bin/sh", [path.join(dir, "swap.sh"), target, path.join(dir, "missing.app"), "", "0"], { stdio: "pipe" })).toThrow();
    expect(existsSync(target)).toBe(true);
  });
});
