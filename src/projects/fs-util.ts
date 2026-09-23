// src/projects/fs-util.ts — small synchronous file helpers for the ~/.ruah
// stores: atomic replace (write a sibling temp file, then rename over the
// target: readers see the old or the new file, never a torn one) and reading
// just the first line of a file (chat headers).
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

let tmpCounter = 0;

export function atomicWriteFileSync(filePath: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  tmpCounter += 1;
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The first line of a file (without the newline), or undefined when it cannot be read. */
export function readFirstLine(filePath: string, maxBytes = 1_048_576): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(16_384);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      const nl = chunk.indexOf(10);
      if (nl !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += n;
      if (total >= maxBytes) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** CONTRACTS §5.1: ProjectInfo.id = sha1(realpath(root)).slice(0, 12). `root` must already be a realpath. */
export function projectIdFor(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 12);
}

/** Expands a leading "~" (the viewer's path field accepts it). */
export function expandHome(input: string, home: string = process.env.HOME ?? homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}
