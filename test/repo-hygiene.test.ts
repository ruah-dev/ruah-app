// Repository hygiene for a public repo: what `git ls-files` tracks must not carry
// a machine's home folder, secret-shaped strings, signing material or large
// binaries; the GitHub workflows stay least-privilege and pinned; package.json
// and .gitignore keep the metadata and exclusions the release relies on.
// (docs: CONTRIBUTING.md "Before you open a pull request", SECURITY.md.)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function trackedFiles(): string[] | undefined {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter((f) => f.length > 0 && existsSync(join(ROOT, f)));
  } catch {
    return undefined; // not a git checkout (e.g. a source tarball): nothing to check
  }
}

const files = trackedFiles();
const inGit = files !== undefined;

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8000).includes(0);
}

/** Tracked text files with their contents (lockfiles skipped: integrity hashes only). */
function textFiles(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of files ?? []) {
    if (/(^|\/)(pnpm-lock\.yaml|bun\.lock)$/.test(file)) continue;
    const buf = readFileSync(join(ROOT, file));
    if (isText(buf)) out.push({ file, text: buf.toString("utf8") });
  }
  return out;
}

/** Home folders that tests and docs may use as obviously fictional examples. */
const NEUTRAL_HOMES = new Set(["me", "you", "dev", "other", "someone", "user", "runner", "x"]);

/** Token shapes of real credentials (full length, so short test placeholders do not match). */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{40,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ["Slack token", /\bxox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["DigitalOcean token", /\bdo[por]_v1_[a-f0-9]{64}\b/],
  ["Supabase token", /\bsbp_[a-f0-9]{40}\b/],
  ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
];

describe.skipIf(!inGit)("tracked files", () => {
  test("no machine home folders (only fictional ones like /Users/me)", () => {
    const hits: string[] = [];
    for (const { file, text } of textFiles()) {
      for (const m of text.matchAll(/(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g)) {
        if (!NEUTRAL_HOMES.has(m[1]!)) hits.push(`${file}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("no secret-shaped strings", () => {
    const hits: string[] = [];
    for (const { file, text } of textFiles()) {
      for (const [name, re] of SECRET_SHAPES) if (re.test(text)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  test("no environment files, signing material, keys or build artefacts", () => {
    const bad = (files ?? []).filter(
      (f) =>
        /(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(f) ||
        /\.(p12|p8|pem|key|cer|mobileprovision|provisionprofile|dmg|zip|asar|app|exe|node)$/i.test(f) ||
        /^(dist|dist-electron|release|viewer|out)\//.test(f) ||
        /(^|\/)(node_modules|\.output)\//.test(f),
    );
    expect(bad).toEqual([]);
  });

  test("no file over 1 MiB (screenshots and assets stay small)", () => {
    const big = (files ?? []).filter((f) => statSync(join(ROOT, f)).size > 1024 * 1024);
    expect(big).toEqual([]);
  });
});

describe("GitHub workflows", () => {
  const dir = join(ROOT, ".github", "workflows");
  const workflows = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];

  test("there is a CI and a release workflow", () => {
    expect(workflows).toEqual(expect.arrayContaining(["ci.yml", "release.yml"]));
  });

  test.each(workflows)("%s: read-only token by default, actions pinned to full commit SHAs", (name) => {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(text).not.toMatch(/permissions:\s*write-all|pull_request_target/);
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      if (ref.startsWith("./")) continue;
      expect(ref, `${name}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
    // Every checkout drops the token from .git/config.
    const checkouts = text.split(/\n(?=\s*- )/).filter((step) => /uses:\s*actions\/checkout@/.test(step));
    for (const step of checkouts) expect(step).toMatch(/persist-credentials:\s*false/);
  });

  test("only the release's publish job may write, and electron-builder never publishes", () => {
    const text = readFileSync(join(dir, "release.yml"), "utf8");
    expect(text.match(/contents: write/g)).toHaveLength(1);
    expect(text).toMatch(/pnpm dist --publish never/);
    expect(text).toMatch(/--draft/);
  });
});

describe("package metadata and ignores", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;

  test("package.json points at the public repository", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/ruah-dev/ruah-app.git" });
    expect(pkg.homepage).toBe("https://github.com/ruah-dev/ruah-app#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/ruah-dev/ruah-app/issues" });
    expect(typeof pkg.description).toBe("string");
    expect(typeof pkg.license).toBe("string");
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    // Never published to npm by accident.
    expect(pkg.private).toBe(true);
  });

  test(".gitignore keeps build output, secrets and local Ruah state out", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    for (const entry of ["node_modules/", "dist/", "/dist-electron/", "/viewer/", "/release/", "ui/.output/", ".env", ".env.*", "*.p12", "*.p8", "/.ruah/"]) {
      expect(lines, entry).toContain(entry);
    }
  });

  test("the community files a public repo needs are there", () => {
    for (const f of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", ".github/pull_request_template.md", ".github/dependabot.yml"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
  });
});
