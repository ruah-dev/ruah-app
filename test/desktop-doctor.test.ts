import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOCTOR_TOOLS, formatDoctorReport, runDoctorReport, type DoctorReport } from "../src/desktop/doctor.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("ruah app doctor", () => {
  test("covers the agents, git/gh and every cloud CLI the integrations use", () => {
    const names = DOCTOR_TOOLS.flatMap((t) => t.bins);
    for (const bin of ["claude", "cursor-agent", "kiro-cli", "grok", "opencode", "git", "gh", "doctl", "kubectl", "vercel", "supabase", "aws", "gcloud", "az", "wrangler", "railway", "flyctl", "fly", "netlify", "hcloud"]) {
      expect(names).toContain(bin);
    }
  });

  test("looks tools up on the login shell's PATH first, then this process's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ruah-doctor-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const loginBin = join(dir, "login-bin");
    const kubectl = fakeBin(loginBin, "kubectl");
    const git = fakeBin(loginBin, "git");
    const grok = fakeBin(join(dir, "home", ".grok", "bin"), "grok"); // agent install dirs count, like presets.ts
    const report = await runDoctorReport({
      version: "9.9.9",
      env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      readLogin: async (shell) => ({ ok: true, shell, path: loginBin, ms: 12 }),
    });
    expect(report.loginShell).toEqual({ ok: true, ms: 12 });
    expect(report.path.split(":").slice(0, 3)).toEqual([loginBin, "/usr/bin", "/bin"]);
    const byName = new Map(report.tools.map((t) => [t.name, t]));
    expect(byName.get("kubectl")?.path).toBe(kubectl);
    expect(byName.get("git")?.path).toBe(git);
    expect(byName.get("grok")?.path).toBe(grok);
    expect(report.tools).toHaveLength(DOCTOR_TOOLS.length);
    expect(report.home).toBe(join(dir, "home", ".ruah"));

    const text = formatDoctorReport(report);
    expect(text).toContain("Ruah 9.9.9 — doctor");
    expect(text).toContain("sh login shell (12 ms)");
    expect(text).toMatch(new RegExp(`✓ kubectl\\s+${kubectl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(text).toContain("Cloud CLIs");
  });

  test("a failing login shell falls back to this process's PATH and says so", async () => {
    const report = await runDoctorReport({
      version: "1",
      env: { HOME: "/nonexistent", PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
      readLogin: async (shell) => ({ ok: false, shell, error: "zsh did not answer within 5000 ms", ms: 5000 }),
    });
    expect(report.loginShell).toEqual({ ok: false, ms: 5000, error: "zsh did not answer within 5000 ms" });
    expect(report.path).toBe("/usr/bin:/bin");
    expect(formatDoctorReport(report)).toContain("login shell failed: zsh did not answer");
  });

  test("the built CLI prints JSON without a daemon (`ruah app doctor --json --no-login-shell`)", () => {
    const out = spawnSync(process.execPath, [resolve("dist/cli.js"), "doctor", "--json", "--no-login-shell"], { encoding: "utf8" });
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as DoctorReport;
    expect(report.loginShell).toEqual({ ok: false, skipped: true });
    expect(report.tools.map((t) => t.name)).toContain("claude");
    const bad = spawnSync(process.execPath, [resolve("dist/cli.js"), "doctor", "--nope"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
  });
});
