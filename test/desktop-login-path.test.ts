import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_PATH_MARKER,
  applyLoginPath,
  isMinimalPath,
  loginShellInvocation,
  mergePaths,
  parseLoginPath,
  readLoginPath,
  readLoginPathCache,
  writeLoginPathCache,
} from "../src/desktop/login-path.js";

const M = LOGIN_PATH_MARKER;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-login-path-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in login shell: prints a banner like a chatty .zshrc, then `path` between the markers. */
function fakeShell(dir: string, body: string): string {
  const file = join(dir, "fake-shell");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("parseLoginPath", () => {
  test("takes the value between the markers, ignoring rc-file banners around it", () => {
    const out = `\u001b[38;5;214m  RETRO TERMINAL\u001b[0m\nWelcome!\n${M}/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin${M}\nbye\n`;
    expect(parseLoginPath(out)).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin");
  });

  test("drops relative entries and rejects missing markers, empty values and multi-line junk", () => {
    expect(parseLoginPath(`${M}.:bin:/usr/bin${M}`)).toBe("/usr/bin");
    expect(parseLoginPath("PATH=/usr/bin")).toBeUndefined();
    expect(parseLoginPath(`${M}/usr/bin`)).toBeUndefined();
    expect(parseLoginPath(`${M}${M}`)).toBeUndefined();
    expect(parseLoginPath(`${M}/usr/bin\n/bin${M}`)).toBeUndefined();
    expect(parseLoginPath(`${M}relative:only${M}`)).toBeUndefined();
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

  test("launchd's bare PATH is minimal; anything a terminal adds is not", () => {
    expect(isMinimalPath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
    expect(isMinimalPath("/usr/bin/:/bin")).toBe(true);
    expect(isMinimalPath(undefined)).toBe(true);
    expect(isMinimalPath("/opt/homebrew/bin:/usr/bin:/bin")).toBe(false);
  });
});

describe("loginShellInvocation", () => {
  test("zsh and bash run interactive login shells; fish joins its list; csh reads its rc without -l", () => {
    expect(loginShellInvocation("/bin/zsh").args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(loginShellInvocation("/opt/homebrew/bin/bash").args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    const fish = loginShellInvocation("/opt/homebrew/bin/fish");
    expect(fish.args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(fish.args[3]).toContain("string join : $PATH");
    expect(loginShellInvocation("/bin/tcsh").args[0]).toBe("-c");
    for (const shell of ["/bin/zsh", "/opt/homebrew/bin/fish", "/bin/tcsh"]) {
      expect(loginShellInvocation(shell).args.at(-1)).toContain(M);
    }
  });
});

describe("readLoginPath", () => {
  test("a real POSIX shell prints its PATH between the markers", async () => {
    const result = await readLoginPath({ shell: "/bin/sh", env: { PATH: "/usr/bin:/bin", HOME: tempDir() }, timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/bin"]));
  });

  test("a chatty rc file does not confuse it", async () => {
    const shell = fakeShell(tempDir(), `echo "Last login: today"\nprintf '%s' '${M}/fake/bin:/usr/bin${M}'\necho trailing`);
    const result = await readLoginPath({ shell, env: {}, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, path: "/fake/bin:/usr/bin" });
  });

  test("a shell that hangs is killed at the timeout; one that prints nothing is an error", async () => {
    const dir = tempDir();
    const started = Date.now();
    const hung = await readLoginPath({ shell: fakeShell(dir, "sleep 30"), env: {}, timeoutMs: 300 });
    expect(hung.ok).toBe(false);
    if (!hung.ok) expect(hung.error).toMatch(/did not answer within 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);

    const silent = await readLoginPath({ shell: join(dir, "missing-shell"), env: {}, timeoutMs: 2_000 });
    expect(silent.ok).toBe(false);
    const mute = await readLoginPath({ shell: fakeShell(tempDir(), "echo no path here; exit 3"), env: {}, timeoutMs: 2_000 });
    expect(mute).toMatchObject({ ok: false });
    if (!mute.ok) expect(mute.error).toMatch(/exited 3 without printing PATH/);
  });

  test("daemon plumbing never reaches the rc files", async () => {
    const shell = fakeShell(tempDir(), `printf '%s' '${M}/x/'"$ELECTRON_RUN_AS_NODE"'-'"$RUAH_MCP_TOKEN"'-'"$DISABLE_AUTO_UPDATE"'${M}'`);
    const result = await readLoginPath({ shell, env: { ELECTRON_RUN_AS_NODE: "1", RUAH_MCP_TOKEN: "secret" }, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, path: "/x/--true" });
  });
});

describe("cache and applyLoginPath", () => {
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

  test("a Finder launch (bare PATH, no cache) waits for the login shell and caches its answer", async () => {
    const dir = tempDir();
    const shell = fakeShell(dir, `printf '%s' '${M}/Users/me/.local/bin:/opt/homebrew/bin${M}'`);
    const cacheFile = join(dir, "login-path.json");
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    const result = await applyLoginPath({ shell, target, env: {}, cacheFile, timeoutMs: 5_000 });
    expect(result.source).toBe("shell");
    expect(target.PATH).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({ shell, path: "/Users/me/.local/bin:/opt/homebrew/bin" });
  });

  test("with a cache the PATH applies at once and the refresh updates it in the background", async () => {
    const dir = tempDir();
    const shell = fakeShell(dir, `printf '%s' '${M}/new/bin${M}'`);
    const cacheFile = join(dir, "login-path.json");
    writeLoginPathCache(cacheFile, shell, "/old/bin");
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const result = await applyLoginPath({ shell, target, env: {}, cacheFile, timeoutMs: 5_000 });
    expect(result.source).toBe("cache");
    expect(result.path).toBe("/old/bin:/usr/bin:/bin");
    await result.refreshed;
    expect(target.PATH).toBe("/new/bin:/usr/bin:/bin");
    expect(readLoginPathCache(cacheFile, shell)?.path).toBe("/new/bin");
  });

  test("a terminal launch (rich PATH) is not delayed; a failing shell leaves PATH alone", async () => {
    const dir = tempDir();
    const target: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin" };
    const lines: string[] = [];
    const result = await applyLoginPath({
      shell: fakeShell(dir, "exit 1"),
      target,
      env: {},
      cacheFile: join(dir, "login-path.json"),
      timeoutMs: 2_000,
      log: (line) => lines.push(line),
    });
    expect(result.source).toBe("unchanged");
    await result.refreshed;
    expect(target.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(lines.join("\n")).toMatch(/login shell PATH unavailable/);
  });
});
