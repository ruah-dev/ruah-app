// src/projects/project-names.ts — shared by the project service (daemon) and the
// create library (daemon + `ruah app new`): the HTTP-mappable error, folder-name
// validation and the empty map a new project starts with.
import type { Architecture } from "../contracts/architecture.js";

/** An error with the HTTP status the endpoint answers. */
export class ProjectError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

const NAME_MAX = 255;

/** A folder name for create: no path separators, not "." / "..", no control characters. */
export function validateProjectName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new ProjectError(400, "name is empty");
  if (name.length > NAME_MAX) throw new ProjectError(400, `name is longer than ${NAME_MAX} characters`);
  if (name === "." || name === "..") throw new ProjectError(400, "name cannot be . or ..");
  if (/[/\\]/.test(name)) throw new ProjectError(400, "name must not contain path separators");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw new ProjectError(400, "name must not contain control characters");
  return name;
}

/**
 * §20 wizard rule on top of validateProjectName: a plain folder name that works
 * everywhere (Finder, git, npm, GitHub) — no leading dot (hidden folder), none of
 * : * ? " < > | (Windows-reserved; Finder shows ":" as "/"). Returns the problem, or null.
 */
export function plainNameProblem(raw: string): string | null {
  const name = raw.trim();
  try {
    validateProjectName(name);
  } catch (err) {
    return (err as Error).message;
  }
  if (name.startsWith(".")) return "a name starting with a dot makes a hidden folder";
  if (/[:*?"<>|]/.test(name)) return 'use letters, digits, spaces, "-", "_" or "." (no : * ? " < > |)';
  return null;
}

export function emptyArchitecture(name: string): Architecture {
  return { version: 1, name, layers: [], nodes: [], edges: [], workflows: [] };
}
