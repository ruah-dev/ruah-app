import { describe, expect, test } from "vitest";
import { enclosingAppBundle, findInstalledApp, planDesktopLaunch, runOpen, type DesktopLaunchInput } from "../src/desktop/launch.js";

const CHECKOUT = "/Users/me/code/ruah-app";

function input(overrides: Partial<DesktopLaunchInput> & { files?: string[] } = {}): DesktopLaunchInput {
  const files = new Set(overrides.files ?? [`${CHECKOUT}/viewer/index.html`]);
  return {
    packageRoot: CHECKOUT,
    env: { HOME: "/Users/me" },
    platform: "darwin",
    exists: (file) => files.has(file),
    electron: () => "/electron/Electron.app/Contents/MacOS/Electron",
    ...overrides,
  };
}

describe("planDesktopLaunch", () => {
  test("an installed Ruah.app wins: `open -a` hands the folder to the running app", () => {
    const plan = planDesktopLaunch(input({ repo: "/work/api", files: ["/Applications/Ruah.app"] }));
    expect(plan).toEqual({ kind: "bundle", bundle: "/Applications/Ruah.app", command: "open", args: ["-a", "/Applications/Ruah.app", "/work/api"] });
  });

  test("~/Applications is found too, and RUAH_HOME / RUAH_AGENT / RUAH_PORT travel with --env", () => {
    const plan = planDesktopLaunch(
      input({ env: { HOME: "/Users/me", RUAH_HOME: "/tmp/scratch", RUAH_AGENT: "mock", RUAH_PORT: " " }, files: ["/Users/me/Applications/Ruah.app"] }),
    );
    expect(plan).toEqual({
      kind: "bundle",
      bundle: "/Users/me/Applications/Ruah.app",
      command: "open",
      args: ["-a", "/Users/me/Applications/Ruah.app", "--env", "RUAH_HOME=/tmp/scratch", "--env", "RUAH_AGENT=mock"],
    });
  });

  test("without an installed app a checkout runs its own Electron on the folder", () => {
    expect(planDesktopLaunch(input({ repo: "/work/api" }))).toEqual({
      kind: "electron",
      command: "/electron/Electron.app/Contents/MacOS/Electron",
      args: [CHECKOUT, "/work/api"],
    });
  });

  test("RUAH_APP_DEV=1 and other platforms skip the bundle", () => {
    const files = ["/Applications/Ruah.app", `${CHECKOUT}/viewer/index.html`];
    expect(planDesktopLaunch(input({ env: { RUAH_APP_DEV: "1" }, files })).kind).toBe("electron");
    expect(planDesktopLaunch(input({ platform: "linux", files })).kind).toBe("electron");
  });

  test("the CLI inside Ruah.app opens its own bundle", () => {
    const root = "/Volumes/Ruah 0.1.0/Ruah.app/Contents/Resources/app";
    const plan = planDesktopLaunch(input({ packageRoot: root, files: [] }));
    expect(plan).toMatchObject({ kind: "bundle", bundle: "/Volumes/Ruah 0.1.0/Ruah.app" });
  });

  test("a checkout without its viewer or Electron says how to fix it", () => {
    expect(planDesktopLaunch(input({ files: [] }))).toMatchObject({ kind: "error", message: expect.stringMatching(/pnpm ui:build/) });
    expect(planDesktopLaunch(input({ electron: () => undefined }))).toMatchObject({ kind: "error", message: expect.stringMatching(/pnpm install/) });
  });
});

describe("app bundle discovery", () => {
  test("enclosingAppBundle recognises a packaged app's resources folder only", () => {
    expect(enclosingAppBundle("/Applications/Ruah.app/Contents/Resources/app")).toBe("/Applications/Ruah.app");
    expect(enclosingAppBundle("/Applications/Ruah.app/Contents/Resources/app/")).toBe("/Applications/Ruah.app");
    expect(enclosingAppBundle(CHECKOUT)).toBeUndefined();
  });

  test("RUAH_APP_BUNDLE overrides the search, and only when it exists", () => {
    const exists = (file: string): boolean => file === "/scratch/Ruah.app" || file === "/Applications/Ruah.app";
    expect(findInstalledApp({ RUAH_APP_BUNDLE: "/scratch/Ruah.app" }, exists)).toBe("/scratch/Ruah.app");
    expect(findInstalledApp({ RUAH_APP_BUNDLE: "/gone/Ruah.app" }, exists)).toBeUndefined();
    expect(findInstalledApp({}, exists)).toBe("/Applications/Ruah.app");
    expect(findInstalledApp({ HOME: "/Users/me" }, () => false)).toBeUndefined();
  });
});

describe("runOpen (`ruah app` waits for `open -a`)", () => {
  test("success is open's exit 0", async () => {
    expect(await runOpen("/bin/sh", ["-c", "exit 0"])).toEqual({ ok: true });
  });

  test("a failed launch (e.g. an app Gatekeeper blocked) is reported with open's own message", async () => {
    const outcome = await runOpen("/bin/sh", ["-c", "echo 'The application cannot be opened because its executable is missing.' >&2; exit 1"]);
    expect(outcome).toEqual({ ok: false, message: "The application cannot be opened because its executable is missing." });
    expect(await runOpen("/bin/sh", ["-c", "exit 3"])).toEqual({ ok: false, message: "sh exited 3" });
    expect(await runOpen("/nonexistent/open", [])).toMatchObject({ ok: false, message: expect.stringMatching(/ENOENT/) });
  });

  test("an open that hangs is given up on", async () => {
    expect(await runOpen("/bin/sh", ["-c", "sleep 10"], 200)).toMatchObject({ ok: false, message: expect.stringMatching(/did not return/) });
  });
});
