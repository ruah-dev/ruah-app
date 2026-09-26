// scripts/privacy/scan-history.ts (docs/CONTRACTS.md §22.6): a history scan that can find
// nothing looks exactly like a clean history, so every check here starts from a history
// that DOES contain the terms (the positive control) — including in objects that only
// older commits reach, commit messages, file names and branch names.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { homeFolderHits, loadPrivateTerms, parsePrivateTerms, privateTermMatcher } from "../scripts/privacy/patterns.js";
import { main, parseCatFileBatch, scanHistory } from "../scripts/privacy/scan-history.js";

const base = mkdtempSync(join(tmpdir(), "ruah-privacy-scan-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Real-looking home folders are built at run time: test/repo-hygiene.test.ts rejects them
// in tracked files, this one included.
const USERS = ["", "Users", ""].join("/"); // "/Users/"
const alice = `${USERS}ali${"ce"}`;

// Neither the user's global git config (hooks, signing) nor the system's.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  });
}
function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

/** A repository whose CURRENT tree is clean, while its history names every term. */
function dirtyHistoryRepo(): string {
  const repo = join(base, `dirty-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, "notes.md"), `Deploy for Acme-Secret-Client from ${alice}/work\n`);
  mkdirSync(join(repo, "zebra-orchard-docs"));
  writeFileSync(join(repo, "zebra-orchard-docs", "a.txt"), "plain\n");
  commitAll(repo, "docs: notes");
  git(repo, "rm", "-q", "-r", "notes.md", "zebra-orchard-docs");
  writeFileSync(join(repo, "README.md"), "Nothing to see.\n");
  commitAll(repo, "chore: tidy up after the quokka-bank-prod migration");
  git(repo, "branch", "wip/umbrella-tenant-x");
  git(repo, "tag", "-a", "v0.0.1", "-m", "release notes mention Acme-Secret-Client too");
  return repo;
}

const TERMS = "# private terms for the test\nacme-secret-client\n\nzebra-orchard\nquokka-bank # a resource\numbrella-tenant\nnever-in-history\n";

describe("scanHistory", () => {
  const repo = dirtyHistoryRepo();
  const terms = parsePrivateTerms(TERMS);
  const scan = scanHistory(repo, terms);

  test("reads every file's contents (the `rev-list --objects | cat-file --batch-check` bug read none)", () => {
    const listed = git(repo, "rev-list", "--objects", "--all").trim().split("\n").map((l) => l.split(" ")[0]!);
    const blobs = execFileSync("git", ["-C", repo, "cat-file", "--batch-check=%(objecttype)"], { input: `${listed.join("\n")}\n`, encoding: "utf8", env: GIT_ENV })
      .trim()
      .split("\n")
      .filter((t) => t === "blob").length;
    expect(blobs).toBe(3); // notes.md, a.txt, README.md
    expect(scan.counts.blobs).toBe(blobs);
    expect(scan.counts.commits).toBe(2);
    expect(scan.counts.tags).toBe(1);
    expect(scan.counts.bytes).toBeGreaterThan(0);
  });

  test("finds terms in deleted files, folder names, commit and tag messages and branch names", () => {
    const at = (line: number) => (scan.hits.get(`private term on line ${line}`) ?? []).map((h) => h.kind).sort();
    expect(at(2)).toEqual(["blob", "tag"]); // acme-secret-client: a deleted file + the tag message
    expect(at(4)).toEqual(["tree"]); // zebra-orchard: a folder name
    expect(at(5)).toEqual(["commit"]); // quokka-bank: a commit message
    expect(at(6)).toEqual(["ref"]); // umbrella-tenant: a branch name
    expect(scan.hits.has("private term on line 7")).toBe(false);
    expect([...(scan.hits.get("home folder (/Users/<name>, /home/<name>)") ?? [])].map((h) => h.kind)).toEqual(["blob"]);
  });

  test("hides paths and ref names that contain a term", () => {
    const serialized = JSON.stringify([...scan.hits.values()]).toLowerCase();
    for (const t of terms) expect(serialized).not.toContain(t.term.toLowerCase());
    expect(serialized).toContain("notes.md");
  });

  test("a clean history has no hits", () => {
    const clean = join(base, "clean");
    mkdirSync(clean);
    execFileSync("git", ["init", "-q", "-b", "main", clean], { env: GIT_ENV });
    writeFileSync(join(clean, "README.md"), "Examples live in /Users/me/projects.\n");
    commitAll(clean, "docs: readme");
    const result = scanHistory(clean, terms);
    expect(result.counts.blobs).toBe(1);
    expect([...result.hits.keys()]).toEqual([]);
  });

  test("a missing object is an error, never a silent skip", () => {
    expect(() => parseCatFileBatch(Buffer.from("0123abcd missing\n"))).toThrow(/cannot read object/);
    const ok = parseCatFileBatch(Buffer.from("aa blob 3\nabc\nbb blob 0\n\n"));
    expect(ok.map((o) => [o.id, o.type, o.body.toString()])).toEqual([
      ["aa", "blob", "abc"],
      ["bb", "blob", ""],
    ]);
  });
});

describe("pnpm privacy:scan (CLI)", () => {
  const repo = dirtyHistoryRepo();
  const termsFile = join(base, "terms.txt");
  writeFileSync(termsFile, TERMS);

  function run(...args: string[]): { code: number; output: string } {
    const lines: string[] = [];
    const code = main(["--repo", repo, ...args], (s) => lines.push(s));
    return { code, output: lines.join("\n") };
  }

  test("exit 1 with hits; the output names term lines, never the terms", () => {
    const { code, output } = run("--terms", termsFile);
    expect(code).toBe(1);
    expect(output).toMatch(/FOUND private term on line 2: 1 blob, 1 tag/);
    for (const t of parsePrivateTerms(TERMS)) expect(output.toLowerCase()).not.toContain(t.term.toLowerCase());
  });

  test("--expect-hits (the positive control) passes on the original history and fails on a clean one", () => {
    expect(run("--terms", termsFile, "--expect-hits").code).toBe(0);
    const clean = join(base, "clean-cli");
    mkdirSync(clean);
    execFileSync("git", ["init", "-q", "-b", "main", clean], { env: GIT_ENV });
    writeFileSync(join(clean, "a.txt"), "hello\n");
    commitAll(clean, "init");
    const lines: string[] = [];
    expect(main(["--repo", clean, "--terms", termsFile, "--expect-hits"], (s) => lines.push(s))).toBe(1);
    expect(lines.join("\n")).toMatch(/Positive control FAILED/);
    expect(main(["--repo", clean, "--terms", termsFile], () => {})).toBe(0);
  });

  test("exit 2 when the terms file is missing or has no usable term, or the folder is not a repository", () => {
    expect(run("--terms", join(base, "no-such-file.txt"))).toMatchObject({ code: 2, output: expect.stringMatching(/cannot be read/) });
    const empty = join(base, "empty.txt");
    writeFileSync(empty, "# nothing but comments\nzz\n\n");
    expect(run("--terms", empty)).toMatchObject({ code: 2, output: expect.stringMatching(/no term/) });
    const notRepo = join(base, "not-a-repo");
    mkdirSync(notRepo);
    expect(main(["--repo", notRepo], () => {})).toBe(2);
    expect(main(["--bogus"], () => {})).toBe(2);
  });

  test("runs as a script (pnpm privacy:scan → tsx scripts/privacy/scan-history.ts)", () => {
    const tsx = resolve("node_modules/.bin/tsx");
    const out = spawnSync(tsx, ["scripts/privacy/scan-history.ts", "--repo", repo, "--terms", termsFile], { encoding: "utf8", env: { ...GIT_ENV, RUAH_PRIVATE_TERMS_FILE: "" } });
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/FOUND private term on line 6: 1 ref/);
  });
});

describe("patterns", () => {
  test("terms keep their line numbers; comments, blank and short lines are dropped", () => {
    expect(parsePrivateTerms("# clients\nAcme-Secret-Client\n\nzz\nother-name  # trailing note\n")).toEqual([
      { term: "Acme-Secret-Client", line: 2 },
      { term: "other-name", line: 5 },
    ]);
    expect(privateTermMatcher(parsePrivateTerms("a\nACME-thing\nzeta-corp\n"))("see acme-THING and Zeta-Corp")).toEqual([2, 3]);
  });

  test("loadPrivateTerms refuses an unreadable or empty list without naming its path", () => {
    const missing = join(base, "private-list-missing.txt");
    expect(() => loadPrivateTerms(missing)).toThrow(/cannot be read/);
    try {
      loadPrivateTerms(missing);
    } catch (err) {
      expect((err as Error).message).not.toContain(missing);
    }
    const empty = join(base, "private-list-empty.txt");
    writeFileSync(empty, "# only a comment\n");
    expect(() => loadPrivateTerms(empty)).toThrow(/no term/);
  });

  test("home folders: macOS, Linux, dash-encoded agent folders, Windows and macOS temp folders", () => {
    const u = "Users";
    expect(homeFolderHits(`${alice}/x`)).toHaveLength(1);
    expect(homeFolderHits(`/${"home"}/bob/x`)).toHaveLength(1);
    expect(homeFolderHits(`~/.claude/projects/-${u}-carol-Projects-x/1.jsonl`)).toEqual(["home folder, dash-encoded (-Users-<name>-)"]);
    expect(homeFolderHits(`C:\\${u}\\dave\\repo`)).toEqual(["home folder, Windows (C:\\Users\\<name>)"]);
    expect(homeFolderHits(`"C:\\\\${u}\\\\erin\\\\repo"`)).toHaveLength(1); // as escaped in JSON
    expect(homeFolderHits(`/var/${"folders"}/2x/7rz8h8m94_s0q5z5b4lq3x0h0000gn/T/ruah-1`)).toEqual(["macOS per-user temp folder (/var/folders/…)"]);
    // Fictional homes and look-alikes pass.
    expect(homeFolderHits("/Users/me/projects -Users-me-x- C:\\Users\\user\\x nav-home-link-active /home/runner/work")).toEqual([]);
  });
});
