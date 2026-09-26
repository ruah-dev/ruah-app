import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_ENV_MARKER,
  applyLoginEnv,
  cleanPath,
  effectivePath,
  isMinimalPath,
  loginShellInvocation,
  mergePaths,
  missingLoginVars,
  parseLoginEnv,
  readLoginEnv,
  readLoginPathCache,
  writeLoginPathCache,
} from "../src/desktop/login-env.js";

const M = LOGIN_ENV_MARKER;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-login-env-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in login shell (a script run as `<shell> -i -l -c <command>`; `body` decides what it prints). */
function fakeShell(dir: string, body: string): string {
  const file = join(dir, "fake-shell");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A fake shell whose environment answer is `vars` (NUL-separated, between the markers), after a banner. */
function envShell(dir: string, vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\\0");
  return fakeShell(dir, `echo "Last login: today"\nprintf '%s' '${M}'\nprintf '${body}\\0'\nprintf '%s' '${M}'\necho trailing`);
}

describe("parseLoginEnv / cleanPath", () => {
  test("takes the NUL-separated entries between the markers, ignoring rc-file banners around them", () => {
    const out = `\u001b[38;5;214m  RETRO TERMINAL\u001b[0m\nWelcome!\n${M}PATH=/Users/me/.local/bin:/opt/homebrew/bin\0ANTHROPIC_API_KEY=sk-test\0MULTI=a\nb=c\0${M}\nbye\n`;
    expect(parseLoginEnv(out)).toEqual({ PATH: "/Users/me/.local/bin:/opt/homebrew/bin", ANTHROPIC_API_KEY: "sk-test", MULTI: "a\nb=c" });
  });

  test("an env without -0 (one entry per line) is read too; continuation lines stay with their value", () => {
    expect(parseLoginEnv(`${M}PATH=/opt/homebrew/bin:/usr/bin\nNOTE=line1\nline2\nAWS_PROFILE=work\n${M}`)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      NOTE: "line1\nline2",
      AWS_PROFILE: "work",
    });
  });

  test("rejects missing markers and nameless or invalid entries", () => {
    expect(parseLoginEnv("PATH=/usr/bin")).toBeUndefined();
    expect(parseLoginEnv(`${M}PATH=/usr/bin`)).toBeUndefined();
    expect(parseLoginEnv(`${M}${M}`)).toBeUndefined();
    expect(parseLoginEnv(`${M}=x\0not a name=1\0OK=1\0${M}`)).toEqual({ OK: "1" });
  });

  test("cleanPath keeps absolute entries only", () => {
    expect(cleanPath(".:bin:/usr/bin")).toBe("/usr/bin");
    expect(cleanPath("relative:only")).toBeUndefined();
    expect(cleanPath("/usr/bin\n/bin")).toBeUndefined();
    expect(cleanPath(undefined)).toBeUndefined();
  });
});

describe("mergePaths / isMinimalPath", () => {
  test("login PATH first, then what only the process had; duplicates, trailing slashes and relatives go", () => {
    expect(mergePaths("/a/bin:/opt/homebrew/bin/:/usr/bin", "/usr/bin:/bin:./node_modules/.bin:/a/bin:/electron/extra")).toBe(
      "/a/bin:/opt/homebrew/bin:/usr/bin:/bin:/electron/extra",
    );
    expect(mergePaths("/x", undefined)).toBe("/x");
    expect(mergePaths("/", "/")).toBe("/");
  });

  test("a GUI launch takes the login PATH first; a terminal's PATH keeps its order and only gains what it lacks", () => {
    expect(effectivePath("/usr/bin:/bin:/usr/sbin:/sbin", "/login/bin:/usr/bin")).toBe("/login/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    // An active venv / `nvm use` / project bin stays in front of the login shell's dirs.
    expect(effectivePath("/project/venv/bin:/login/bin:/usr/bin:/bin", "/login/bin:/usr/bin:/bin:/opt/homebrew/bin")).toBe(
      "/project/venv/bin:/login/bin:/usr/bin:/bin:/opt/homebrew/bin",
    );
  });

  test("launchd's bare PATH is minimal; anything a terminal adds is not", () => {
    expect(isMinimalPath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
    expect(isMinimalPath("/usr/bin/:/bin")).toBe(true);
    expect(isMinimalPath(undefined)).toBe(true);
    expect(isMinimalPath("/opt/homebrew/bin:/usr/bin:/bin")).toBe(false);
  });
});

describe("missingLoginVars", () => {
  test("only what the process lacks; never PATH, per-shell state, daemon plumbing or the instance's identity", () => {
    const login = {
      PATH: "/login/bin",
      ANTHROPIC_API_KEY: "k",
      AWS_PROFILE: "work",
      HOME: "/Users/other",
      PWD: "/",
      OLDPWD: "/",
      SHLVL: "1",
      _: "/usr/bin/env",
      TERM: "xterm",
      ELECTRON_RUN_AS_NODE: "1",
      RUAH_HOME: "/elsewhere",
      RUAH_CURSOR_BIN: "/opt/cursor-agent",
    };
    expect(missingLoginVars({ HOME: "/Users/me", PATH: "/usr/bin" }, login)).toEqual(["ANTHROPIC_API_KEY", "AWS_PROFILE", "RUAH_CURSOR_BIN"]);
  });
});

describe("loginShellInvocation", () => {
  test("zsh and bash run interactive login shells; fish too; csh reads its rc without -l; all print env -0 between markers", () => {
    expect(loginShellInvocation("/bin/zsh").args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(loginShellInvocation("/opt/homebrew/bin/bash").args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(loginShellInvocation("/opt/homebrew/bin/fish").args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(loginShellInvocation("/bin/tcsh").args[0]).toBe("-c");
    for (const shell of ["/bin/zsh", "/opt/homebrew/bin/fish", "/bin/tcsh"]) {
      const command = loginShellInvocation(shell).args.at(-1) ?? "";
      expect(command).toContain(M);
      expect(command).toContain("/usr/bin/env -0");
    }
  });
});

describe("readLoginEnv", () => {
  test("a real POSIX shell prints its environment between the markers", async () => {
    const result = await readLoginEnv({ shell: "/bin/sh", env: { PATH: "/usr/bin:/bin", HOME: tempDir(), AWS_PROFILE: "work" }, timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/bin"]));
      expect(result.env.AWS_PROFILE).toBe("work");
    }
  });

  test("a chatty rc file does not confuse it; values may hold newlines", async () => {
    const shell = envShell(tempDir(), { PATH: "/fake/bin:/usr/bin", KUBECONFIG: "/Users/me/.kube/work", NOTE: "line1\\nline2" });
    const result = await readLoginEnv({ shell, env: {}, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, path: "/fake/bin:/usr/bin", env: { KUBECONFIG: "/Users/me/.kube/work", NOTE: "line1\nline2" } });
  });

  test("a shell that hangs is killed at the timeout; one that prints nothing is an error", async () => {
    const dir = tempDir();
    const started = Date.now();
    const hung = await readLoginEnv({ shell: fakeShell(dir, "sleep 30"), env: {}, timeoutMs: 300 });
    expect(hung.ok).toBe(false);
    if (!hung.ok) expect(hung.error).toMatch(/did not answer within 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);

    const silent = await readLoginEnv({ shell: join(dir, "missing-shell"), env: {}, timeoutMs: 2_000 });
    expect(silent.ok).toBe(false);
    const mute = await readLoginEnv({ shell: fakeShell(tempDir(), "echo no env here; exit 3"), env: {}, timeoutMs: 2_000 });
    expect(mute).toMatchObject({ ok: false });
    if (!mute.ok) expect(mute.error).toMatch(/exited 3 without printing its environment/);
    const pathless = await readLoginEnv({ shell: envShell(tempDir(), { HOME: "/x" }), env: {}, timeoutMs: 2_000 });
    if (!pathless.ok) expect(pathless.error).toMatch(/no usable PATH/);
    expect(pathless.ok).toBe(false);
  });

  test("daemon plumbing never reaches the rc files", async () => {
    const shell = fakeShell(tempDir(), `printf '%s' '${M}PATH=/x/'"$ELECTRON_RUN_AS_NODE"'-'"$RUAH_MCP_TOKEN"'-'"$RUAH_PARENT_PID"'-'"$DISABLE_AUTO_UPDATE"'${M}'`);
    const result = await readLoginEnv({ shell, env: { ELECTRON_RUN_AS_NODE: "1", RUAH_MCP_TOKEN: "secret", RUAH_PARENT_PID: "1" }, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, path: "/x/---true" });
  });
});

describe("cache and applyLoginEnv", () => {
  test("the cache is per shell and ignores junk", () => {
    const dir = tempDir();
    const file = join(dir, "cache", "login-path.json");
    writeLoginPathCache(file, "/bin/zsh", "/a:/b", new Date("2026-09-25T00:00:00Z"));
    expect(readLoginPathCache(file, "/bin/zsh")).toEqual({ version: 1, shell: "/bin/zsh", path: "/a:/b", resolvedAt: "2026-09-25T00:00:00.000Z" });
    expect(readLoginPathCache(file, "/bin/bash")).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(readLoginPathCache(file, "/bin/zsh")).toBeUndefined();
    expect(readLoginPathCache(join(dir, "nope.json"), "/bin/zsh")).toBeUndefined();
  });

  test("a Finder launch (bare environment) waits for the login shell: PATH first, profile variables filled in, PATH cached", async () => {
    const dir = tempDir();
    const shell = envShell(dir, {
      PATH: "/Users/me/.local/bin:/opt/homebrew/bin",
      ANTHROPIC_API_KEY: "sk-from-zshrc",
      AWS_PROFILE: "work",
      LANG: "en_GB.UTF-8",
      HOME: "/not/mine",
      SHLVL: "2",
    });
    const cacheFile = join(dir, "login-path.json");
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/me" };
    const lines: string[] = [];
    const result = await applyLoginEnv({ shell, target, env: {}, cacheFile, timeoutMs: 5_000, log: (line) => lines.push(line) });
    expect(result.source).toBe("shell");
    expect(result.added).toEqual(["ANTHROPIC_API_KEY", "AWS_PROFILE", "LANG"]);
    expect(target).toEqual({
      PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/me", // never overwritten
      ANTHROPIC_API_KEY: "sk-from-zshrc",
      AWS_PROFILE: "work",
      LANG: "en_GB.UTF-8",
    });
    expect(lines.join("\n")).toMatch(/PATH \+ 3 variables/);
    expect(lines.join("\n")).not.toContain("sk-from-zshrc"); // names at most, never values
    const cache = readFileSync(cacheFile, "utf8");
    expect(JSON.parse(cache)).toMatchObject({ shell, path: "/Users/me/.local/bin:/opt/homebrew/bin" });
    expect(cache).not.toContain("sk-from-zshrc"); // only the PATH is cached
  });

  test("a Finder launch whose shell fails falls back to the cached PATH", async () => {
    const dir = tempDir();
    const shell = fakeShell(dir, "exit 1");
    const cacheFile = join(dir, "login-path.json");
    writeLoginPathCache(cacheFile, shell, "/old/bin", new Date("2026-09-25T00:00:00Z"));
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const lines: string[] = [];
    const result = await applyLoginEnv({ shell, target, env: {}, cacheFile, timeoutMs: 5_000, log: (line) => lines.push(line) });
    expect(result).toMatchObject({ source: "cache", path: "/old/bin:/usr/bin:/bin", added: [] });
    expect(target.PATH).toBe("/old/bin:/usr/bin:/bin");
    expect(lines.join("\n")).toMatch(/unavailable[\s\S]*cached 2026-09-25/);
  });

  test("a terminal launch (rich PATH) is not delayed and keeps its PATH order; the shell only fills gaps", async () => {
    const dir = tempDir();
    const shell = envShell(dir, { PATH: "/login/bin:/usr/bin:/bin", KUBECONFIG: "/k", AWS_PROFILE: "other" });
    const target: NodeJS.ProcessEnv = { PATH: "/project/venv/bin:/login/bin:/usr/bin:/bin", AWS_PROFILE: "mine" };
    const result = await applyLoginEnv({ shell, target, env: {}, cacheFile: join(dir, "login-path.json"), timeoutMs: 5_000 });
    expect(result.source).toBe("unchanged");
    expect(target.PATH).toBe("/project/venv/bin:/login/bin:/usr/bin:/bin");
    await result.refreshed;
    expect(target.PATH).toBe("/project/venv/bin:/login/bin:/usr/bin:/bin");
    expect(target.AWS_PROFILE).toBe("mine");
    expect(target.KUBECONFIG).toBe("/k");
  });

  test("a failing shell leaves the environment alone", async () => {
    const dir = tempDir();
    const target: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin" };
    const lines: string[] = [];
    const result = await applyLoginEnv({
      shell: fakeShell(dir, "exit 1"),
      target,
      env: {},
      cacheFile: join(dir, "login-path.json"),
      timeoutMs: 2_000,
      log: (line) => lines.push(line),
    });
    expect(result.source).toBe("unchanged");
    await result.refreshed;
    expect(target).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(lines.join("\n")).toMatch(/login shell environment unavailable/);
  });
});
