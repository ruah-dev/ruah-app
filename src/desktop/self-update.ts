// src/desktop/self-update.ts — keeps the installed desktop app on the newest commit of the
// checkout it was built from. Ruah publishes no releases, so "an update" is a commit: the app's
// package.json carries `ruahBuild` (scripts/macos/build-stamp.cjs: commit, repo, ref), and the
// daemon of the packaged app
//   1. checks `git rev-parse <ref>` in that repo (at start, every 10 minutes, on request);
//   2. on a new commit builds it in the background, in a worktree of its own
//      (<RUAH_HOME>/app-update/build: `pnpm install`, `bun install` in ui/, `pnpm dist:app`),
//      so uncommitted edits in the checkout never ship, and stages the .app;
//   3. installs the staged app when asked ("Restart to update") or when the app quits:
//      a detached shell script waits for the app to exit, swaps the bundle and, for a restart,
//      opens it again. The script never runs from inside the bundle it replaces.
// Only commits count: uncommitted work in the checkout is not an update.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withoutDaemonPlumbing } from "./child-env.js";

const execFileAsync = promisify(execFile);

export const CHECK_INTERVAL_MS = 10 * 60_000;

/** `ruahBuild` in the app's package.json. */
export interface BuildInfo {
  commit: string;
  repo: string;
  ref: string;
  dirty: boolean;
  builtAt: string;
}

export type UpdatePhase = "unsupported" | "current" | "available" | "building" | "ready" | "failed" | "installing";

export interface AppUpdateStatus {
  phase: UpdatePhase;
  /** Why updates are off (phase "unsupported"). */
  reason?: string;
  /** The running app's commit. */
  current?: string;
  repo?: string;
  ref?: string;
  /** The commit the ref points at now. */
  latest?: string;
  /** Commits from current to latest (undefined when they are unrelated). */
  behind?: number;
  /** Subject of the latest commit. */
  subject?: string;
  /** What the build is doing (phase "building"). */
  step?: string;
  error?: string;
  /** The build log (phases "building", "failed"). */
  logFile?: string;
  checkedAt?: string;
  /** Updates build and install by themselves (RUAH_AUTO_UPDATE=0 turns it off). */
  auto: boolean;
}

export function readBuildInfo(pkg: unknown): BuildInfo | undefined {
  if (pkg === null || typeof pkg !== "object") return undefined;
  const raw = (pkg as Record<string, unknown>).ruahBuild;
  if (raw === null || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (typeof b.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(b.commit)) return undefined;
  if (typeof b.repo !== "string" || b.repo.length === 0) return undefined;
  return {
    commit: b.commit,
    repo: b.repo,
    ref: typeof b.ref === "string" && b.ref.length > 0 ? b.ref : "main",
    dirty: b.dirty === true,
    builtAt: typeof b.builtAt === "string" ? b.builtAt : "",
  };
}

/** The .app bundle an executable runs from (…/Ruah.app/Contents/MacOS/Ruah), else undefined. */
export function bundleOf(execPath: string): string | undefined {
  const bundle = path.resolve(execPath, "..", "..", "..");
  return bundle.endsWith(".app") && path.basename(path.dirname(execPath)) === "MacOS" ? bundle : undefined;
}

/**
 * Whether the checkout's ref is an update for this build: another commit, or the same commit when
 * nothing newer exists is not. Pure; unit-tested.
 */
export function isUpdate(current: string, latest: string | undefined): boolean {
  return latest !== undefined && latest !== current;
}

/** The swap script: waits for the app to quit, replaces the bundle, optionally reopens it. */
export const SWAP_SCRIPT = `#!/bin/sh
# Written by Ruah (src/desktop/self-update.ts): installs a staged build of the app.
# usage: swap.sh <target .app> <staged .app> <app pid or ""> <relaunch 0|1>
TARGET="$1"; STAGED="$2"; PID="$3"; RELAUNCH="$4"
echo "[swap] $(date '+%F %T') target=$TARGET pid=$PID relaunch=$RELAUNCH"
[ -d "$STAGED" ] || { echo "[swap] nothing staged at $STAGED"; exit 1; }
if [ -n "$PID" ] && [ "$RELAUNCH" = 1 ]; then kill -TERM "$PID" 2>/dev/null; fi
i=0
while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 600 ] && { echo "[swap] the app did not quit"; exit 1; }
  sleep 0.1
done
# Agents and helpers started from the bundle get a moment to go too.
i=0
while pgrep -f "$TARGET/Contents/" >/dev/null 2>&1 && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
rm -rf "$TARGET.previous"
if mv "$TARGET" "$TARGET.previous" && mv "$STAGED" "$TARGET"; then
  rm -rf "$TARGET.previous"
  echo "[swap] installed"
else
  echo "[swap] swap failed; keeping the previous app"
  [ -d "$TARGET" ] || mv "$TARGET.previous" "$TARGET"
  exit 1
fi
[ "$RELAUNCH" = 1 ] && open "$TARGET"
exit 0
`;

export interface SelfUpdaterOptions {
  info: BuildInfo | undefined;
  /** The installed bundle (undefined: not a packaged app). */
  bundle: string | undefined;
  /** <RUAH_HOME>; the updater works in <home>/app-update. */
  home: string;
  /** The app's flavor (package.json ruahFlavor), rebuilt as the same flavor. */
  flavor?: string;
  /** The desktop app's pid (RUAH_PARENT_PID). */
  appPid?: number;
  env?: NodeJS.ProcessEnv;
  auto?: boolean;
  log?: (line: string) => void;
  /** Status changes (for pushing to viewers). */
  onStatus?: (status: AppUpdateStatus) => void;
}

interface Staged {
  commit: string;
  app: string;
}

export class SelfUpdater {
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private status: AppUpdateStatus;
  private building: Promise<void> | undefined;
  private failedCommit: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SelfUpdaterOptions) {
    this.dir = path.join(options.home, "app-update");
    this.env = withoutDaemonPlumbing({ ...(options.env ?? process.env) });
    const auto = options.auto ?? this.env.RUAH_AUTO_UPDATE !== "0";
    const reason =
      process.platform !== "darwin"
        ? "Updates install on macOS only."
        : options.bundle === undefined
          ? "Not running as an installed app (a dev build updates itself)."
          : options.info === undefined
            ? "This build does not say which commit it was made from — install once with `pnpm app:update`."
            : !existsSync(path.join(options.info.repo, ".git"))
              ? `The checkout it was built from is gone: ${options.info.repo}`
              : undefined;
    this.status =
      reason !== undefined || options.info === undefined
        ? { phase: "unsupported", reason: reason ?? "unsupported", auto }
        : { phase: "current", current: options.info.commit, repo: options.info.repo, ref: options.info.ref, auto };
  }

  get supported(): boolean {
    return this.status.phase !== "unsupported";
  }

  snapshot(): AppUpdateStatus {
    return { ...this.status };
  }

  /** Checks now, then every CHECK_INTERVAL_MS. */
  start(firstDelayMs = 30_000): void {
    if (!this.supported || this.timer !== undefined) return;
    const tick = () => void this.check().catch((cause) => this.log(`update check failed: ${message(cause)}`));
    const first = setTimeout(tick, firstDelayMs);
    first.unref();
    this.timer = setInterval(tick, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks at the ref; builds a new commit by itself when auto is on. */
  async check(): Promise<AppUpdateStatus> {
    const info = this.options.info;
    if (!this.supported || info === undefined) return this.snapshot();
    if (this.status.phase === "building" || this.status.phase === "installing") return this.snapshot();
    const latest = await this.git(info.repo, ["rev-parse", "--verify", `${info.ref}^{commit}`]);
    const checkedAt = new Date().toISOString();
    if (!isUpdate(info.commit, latest)) {
      await this.dropStaged();
      this.set({ phase: "current", latest, checkedAt, behind: 0 });
      return this.snapshot();
    }
    const [count, subject] = await Promise.all([
      this.git(info.repo, ["rev-list", "--count", `${info.commit}..${latest}`]).catch(() => undefined),
      this.git(info.repo, ["log", "-1", "--format=%s", latest]).catch(() => undefined),
    ]);
    const behind = count !== undefined ? Number.parseInt(count, 10) : undefined;
    const base = { latest, checkedAt, ...(behind !== undefined && Number.isFinite(behind) ? { behind } : {}), ...(subject !== undefined ? { subject } : {}) };
    const staged = await this.staged();
    if (staged?.commit === latest) {
      this.set({ phase: "ready", ...base });
      return this.snapshot();
    }
    if (this.failedCommit === latest) {
      this.set({ ...base, phase: "failed" });
      return this.snapshot();
    }
    this.set({ phase: "available", ...base });
    if (this.status.auto) void this.build();
    return this.snapshot();
  }

  /** Builds and stages the ref's current commit (a no-op while a build runs). */
  build(): Promise<void> {
    if (this.building !== undefined) return this.building;
    const info = this.options.info;
    const latest = this.status.latest;
    if (!this.supported || info === undefined || latest === undefined) return Promise.resolve();
    const run = this.runBuild(info, latest).finally(() => {
      this.building = undefined;
    });
    this.building = run;
    return run;
  }

  /** Whether a staged build waits to be installed. */
  get ready(): boolean {
    return this.status.phase === "ready";
  }

  /**
   * Installs the staged build: a detached script waits for the app (pid) to quit, swaps the
   * bundle and, with `relaunch`, opens it again (it also asks the app to quit). False when there is
   * nothing to install.
   */
  async install(relaunch: boolean): Promise<boolean> {
    const bundle = this.options.bundle;
    const staged = await this.staged();
    if (bundle === undefined || staged === undefined || this.status.phase !== "ready") return false;
    await mkdir(this.dir, { recursive: true });
    const script = path.join(this.dir, "swap.sh");
    await writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
    const log = createWriteStream(path.join(this.dir, "swap.log"), { flags: "a" });
    await new Promise<void>((resolve) => log.once("open", () => resolve()));
    const pid = this.options.appPid !== undefined ? String(this.options.appPid) : "";
    const child = spawn("/bin/sh", [script, bundle, staged.app, pid, relaunch ? "1" : "0"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: this.env,
    });
    child.unref();
    log.close();
    this.set({ phase: "installing" });
    this.log(`installing ${staged.commit.slice(0, 7)} into ${bundle}${relaunch ? " and restarting" : " after quit"}`);
    return true;
  }

  private async runBuild(info: BuildInfo, commit: string): Promise<void> {
    const buildDir = path.join(this.dir, "build");
    const logFile = path.join(this.dir, "build.log");
    await mkdir(this.dir, { recursive: true });
    const log = createWriteStream(logFile, { flags: "w" });
    const step = async (label: string, cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) => {
      this.set({ phase: "building", step: label, logFile });
      log.write(`\n$ (${cwd}) ${cmd} ${args.join(" ")}\n`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env: { ...this.env, ...extraEnv, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}) — see ${logFile}`))));
      });
    };
    this.log(`building update ${commit.slice(0, 7)} (log: ${logFile})`);
    try {
      if (!existsSync(path.join(buildDir, ".git"))) {
        await rm(buildDir, { recursive: true, force: true });
        await step("Preparing a build folder", "git", ["-C", info.repo, "worktree", "prune"], info.repo);
        await step("Preparing a build folder", "git", ["-C", info.repo, "worktree", "add", "--detach", "--force", buildDir, commit], info.repo);
      } else {
        await step("Checking out the new commit", "git", ["checkout", "--detach", "--force", commit], buildDir);
        await step("Checking out the new commit", "git", ["clean", "-fdq"], buildDir);
      }
      await step("Installing dependencies", "pnpm", ["install", "--frozen-lockfile"], buildDir);
      await step("Installing dependencies", "bun", ["install", "--frozen-lockfile"], path.join(buildDir, "ui"));
      await step("Building the app", "pnpm", ["dist:app"], buildDir, {
        RUAH_BUILD_REPO: info.repo,
        RUAH_BUILD_REF: info.ref,
        ...(this.options.flavor ? { RUAH_APP_FLAVOR: this.options.flavor } : {}),
      });
      const out = path.join(buildDir, "release", "mac-arm64");
      const app = readdirSync(out).find((name) => name.endsWith(".app"));
      if (app === undefined) throw new Error(`the build made no .app in ${out}`);
      this.set({ phase: "building", step: "Staging the new app", logFile });
      const stagedApp = path.join(this.dir, "staged", app);
      await rm(path.join(this.dir, "staged"), { recursive: true, force: true });
      await mkdir(path.join(this.dir, "staged"), { recursive: true });
      await step("Staging the new app", "ditto", [path.join(out, app), stagedApp], this.dir);
      await writeFile(path.join(this.dir, "staged.json"), `${JSON.stringify({ commit, app: stagedApp } satisfies Staged)}\n`);
      this.failedCommit = undefined;
      this.set({ phase: "ready" });
      this.log(`update ${commit.slice(0, 7)} is ready`);
    } catch (cause) {
      this.failedCommit = commit;
      this.set({ phase: "failed", error: message(cause), logFile });
      this.log(`update build failed: ${message(cause)}`);
    } finally {
      log.end();
    }
  }

  private async staged(): Promise<Staged | undefined> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir, "staged.json"), "utf8")) as Partial<Staged>;
      if (typeof raw.commit !== "string" || typeof raw.app !== "string" || !existsSync(raw.app)) return undefined;
      return { commit: raw.commit, app: raw.app };
    } catch {
      return undefined;
    }
  }

  private async dropStaged(): Promise<void> {
    if ((await this.staged()) === undefined) return;
    await rm(path.join(this.dir, "staged"), { recursive: true, force: true });
    await rm(path.join(this.dir, "staged.json"), { force: true });
  }

  private async git(repo: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: this.env, timeout: 15_000 });
    return stdout.trim();
  }

  private set(patch: Partial<AppUpdateStatus>): void {
    const next: AppUpdateStatus = { ...this.status, ...patch };
    if (patch.phase !== undefined && patch.phase !== "building") delete next.step;
    if (patch.phase !== undefined && patch.phase !== "failed") delete next.error;
    if (patch.phase !== undefined && patch.phase !== "building" && patch.phase !== "failed" && patch.logFile === undefined) delete next.logFile;
    this.status = next;
    this.emit();
  }

  private emit(): void {
    this.options.onStatus?.(this.snapshot());
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
