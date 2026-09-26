// `ruah app serve --help` used to start a daemon on the default port (and `scan --help` to scan
// the working directory): subcommands without a help of their own print the usage instead.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
const cwd = mkdtempSync(join(tmpdir(), "ruah-cli-help-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("help flags on subcommands without their own help", () => {
  for (const args of [["serve", "--help"], ["serve", ".", "-h"], ["scan", "--help"], ["export", "-h"], ["mcp", "--help"]]) {
    it(`${args.join(" ")} prints the usage and exits 0 without running`, () => {
      const out = execFileSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, RUAH_HOME: join(cwd, "home"), RUAH_PORT: "1" },
      });
      expect(out).toContain("ruah app serve [<repo>]");
    });
  }
});
