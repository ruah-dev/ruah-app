// Where a new terminal starts: the project root, a folder the viewer names
// (repo-relative, "<repoId>/<rel>" in a multi-repo system, or absolute), or an
// element's folder (its `path`, else its first file's folder). A file resolves
// to its folder and a path that does not exist (yet) to its nearest existing
// parent. The result must stay inside the project root or, for a system, one
// of its repo roots — symlinks included.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import { systemRootsFor } from "../system/roots.js";

export interface TerminalProject {
  id: string;
  name: string;
  root: string;
  store: ArchitectureStore | null;
}

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export function allowedRoots(project: TerminalProject): string[] {
  return [project.root, ...systemRootsFor(project.root)].map(realOrSelf);
}

/** The folder a terminal for this element would start in (relative spec), or undefined when the element has none. */
function elementPath(project: TerminalProject, nodeId: string): string | undefined {
  const node = project.store?.current()?.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return undefined;
  if (node.path !== undefined && node.path.length > 0) return node.path;
  const file = node.files?.[0];
  return file !== undefined ? path.posix.dirname(file) : ".";
}

export function resolveTerminalCwd(project: TerminalProject, spec: { cwd?: string | undefined; nodeId?: string | undefined }): string {
  let rel: string | undefined;
  if (spec.nodeId !== undefined) {
    rel = elementPath(project, spec.nodeId);
    if (rel === undefined && spec.cwd === undefined) throw new TerminalError(`unknown element "${spec.nodeId}"`, 404);
  }
  rel ??= spec.cwd;
  if (rel === undefined || rel === "" || rel === ".") return realOrSelf(project.root);
  if (rel.includes("\0")) throw new TerminalError("invalid path");

  let abs: string;
  if (path.isAbsolute(rel)) {
    abs = path.resolve(rel);
  } else {
    const normalized = path.posix.normalize(rel.replaceAll("\\", "/")).replace(/\/+$/, "");
    if (normalized === ".." || normalized.startsWith("../")) throw new TerminalError("path escapes the project");
    if (project.store?.resolvePath !== undefined) {
      const hit = project.store.resolvePath(normalized);
      if (hit === null) throw new TerminalError(`unknown repo in path "${rel}"`, 404);
      abs = path.resolve(hit.abs);
    } else {
      abs = path.resolve(project.root, normalized);
    }
  }

  // Nearest existing folder: a file → its folder; a planned path → its parent.
  let dir = abs;
  for (;;) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dir);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) break;
    const parent = path.dirname(dir);
    if (parent === dir) throw new TerminalError("no such folder", 404);
    dir = parent;
  }

  const real = realOrSelf(dir);
  if (!allowedRoots(project).some((root) => inside(real, root))) throw new TerminalError("the folder is outside the project", 403);
  return real;
}
