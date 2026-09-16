// src/serve/files.ts — GET /api/file?path=<rel>: serves a file inside the
// repo root only. Rejects "..", absolute paths, and symlinks resolving
// outside root; 512 KiB cap; binary -> 415; lang from the extension.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import type { ArchitectureStore } from "./architecture-store.js";

export const MAX_FILE_SIZE_BYTES = 512 * 1024;

export const MAX_FILE_BYTES = 512 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".svg": "xml",
  ".xml": "xml",
  ".txt": "text",
};

export function langFor(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  return LANG_BY_EXT[ext] ?? "text";
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}export function serveFile(store: ArchitectureStore, relPath: string, res: ServerResponse): void {
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  };
  if (relPath === "") {
    fail(400, "missing path query parameter");
    return;
  }
  if (relPath.includes("\0")) {
    fail(400, "invalid path");
    return;
  }
  const posix = relPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(posix)) {
    fail(400, "absolute paths are not allowed");
    return;
  }
  const normalized = path.posix.normalize(posix);
  if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized === "") {
    fail(400, "path traversal is not allowed");
    return;
  }
  const abs = path.resolve(store.root, normalized);
  const rootAbs = path.resolve(store.root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    fail(400, "path escapes the repo root");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(abs);
      const realNormalized = path.resolve(real);
      if (realNormalized !== rootAbs && !realNormalized.startsWith(rootAbs + path.sep)) {
        fail(400, "symlink resolves outside the repo root");
        return;
      }
      stat = fs.statSync(abs);
    }
  } catch {
    fail(404, "file not found");
    return;
  }
  if (!stat.isFile()) {
    fail(404, "not a file");
    return;
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    fail(413, "file exceeds 512 KiB");
    return;
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(abs);
  } catch {
    fail(404, "file not found");
    return;
  }
  if (looksBinary(content)) {
    res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "binary file" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ path: normalized, lang: langFor(normalized), content: content.toString("utf8") }));
}
