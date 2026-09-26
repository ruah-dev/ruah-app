// GET /api/file keeps every read inside the repo root (files.ts header,
// SECURITY.md). Regression: only the LAST path segment was checked for a
// symlink, so a committed `etcdir -> /etc` let `?path=etcdir/passwd` read any
// file on disk through the intermediate symlinked folder.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchitectureStore } from "../src/serve/architecture-store.js";
import { serveFile } from "../src/serve/files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { base: string; repo: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ruah-files-"));
  dirs.push(base);
  const repo = path.join(base, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "app.js"), "console.log('inside')\n");
  mkdirSync(path.join(base, "elsewhere"));
  writeFileSync(path.join(base, "elsewhere", "secret.txt"), "OUTSIDE-SECRET\n");
  writeFileSync(path.join(base, "outside.txt"), "OUTSIDE-PARENT\n");
  return { base, repo };
}

function get(repo: string, rel: string): { status: number; body: string } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(body: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  serveFile({ root: repo } as unknown as ArchitectureStore, rel, res);
  return out;
}

describe("serveFile confinement", () => {
  it("serves a normal file inside the repo", () => {
    const { repo } = fixture();
    const res = get(repo, "src/app.js");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ path: "src/app.js", lang: "javascript", content: "console.log('inside')\n" });
  });

  it("rejects a file reached through a symlinked folder that points outside the root", () => {
    const { base, repo } = fixture();
    symlinkSync(path.join(base, "elsewhere"), path.join(repo, "linkdir"));
    symlinkSync("..", path.join(repo, "updir"));
    for (const rel of ["linkdir/secret.txt", "updir/outside.txt", "updir/elsewhere/secret.txt"]) {
      const res = get(repo, rel);
      expect(res.status, rel).toBe(400);
      expect(res.body).not.toContain("OUTSIDE");
    }
  });

  it("still rejects a final-segment symlink to a file outside the root", () => {
    const { base, repo } = fixture();
    symlinkSync(path.join(base, "outside.txt"), path.join(repo, "escape.txt"));
    const res = get(repo, "escape.txt");
    expect(res.status).toBe(400);
    expect(res.body).not.toContain("OUTSIDE");
  });

  it("allows symlinks that stay inside the root", () => {
    const { repo } = fixture();
    symlinkSync("src", path.join(repo, "alias"));
    symlinkSync(path.join(repo, "src", "app.js"), path.join(repo, "app-link.js"));
    expect(get(repo, "alias/app.js").status).toBe(200);
    expect(get(repo, "app-link.js").status).toBe(200);
  });

  it("works when the repo root itself is reached through a symlink", () => {
    const { base, repo } = fixture();
    const viaLink = path.join(base, "repo-link");
    symlinkSync(repo, viaLink);
    expect(get(viaLink, "src/app.js").status).toBe(200);
    symlinkSync(path.join(base, "elsewhere"), path.join(repo, "linkdir"));
    expect(get(viaLink, "linkdir/secret.txt").status).toBe(400);
  });

  it("keeps rejecting lexical traversal and missing files", () => {
    const { repo } = fixture();
    expect(get(repo, "../outside.txt").status).toBe(400);
    expect(get(repo, "/etc/hosts").status).toBe(400);
    expect(get(repo, "nope.txt").status).toBe(404);
    expect(get(repo, "src").status).toBe(404);
  });
});
