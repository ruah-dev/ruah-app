// Clickable things in terminal output (pure, tested in ui/test/terminal-links.test.ts):
// file paths (open the Code view / the element that owns them) and web URLs
// (open in the default browser). A path counts when it looks like one — a folder part
// and an extension, or ./ ../ / at the start — so ordinary words are never links.

export interface PathMatch {
  /** Offset in the line (UTF-16 code units). */
  index: number;
  /** The text as printed, including :line:col. */
  text: string;
  path: string;
  line?: number;
  column?: number;
}

// "src/a/b.ts", "./x.ts", "../y/z.go:12:3", "/abs/file.rs:4", "a/b/c.tsx(12,3)"
const PATH_RE =
  /(?<![\w./@~-])((?:\.{1,2}\/|\/|~\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?(?![\w/])/g;
const DIR_ONLY_RE = /(?<![\w./@~-])((?:\.{1,2}\/|\/)[\w@.+-]+(?:\/[\w@.+-]+)+\/?)(?![\w/])/g;

/** File paths in one line of terminal text. Needs a "/" somewhere, or ./ ../ at the start. */
export function findPaths(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  const taken: [number, number][] = [];
  for (const m of line.matchAll(URL_RE)) taken.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const free = (start: number, end: number) => !taken.some(([s, e]) => start < e && end > s);
  for (const m of line.matchAll(PATH_RE)) {
    const path = m[1] ?? "";
    const index = m.index ?? 0;
    if (!path.includes("/")) continue;
    if (/^\d+(\.\d+)+$/.test(path.split("/").pop() ?? "")) continue; // version numbers "1.2.3"
    if (!free(index, index + m[0].length)) continue;
    const line = m[2] ?? m[4];
    const column = m[3] ?? m[5];
    out.push({
      index,
      text: m[0],
      path,
      ...(line !== undefined ? { line: Number(line) } : {}),
      ...(column !== undefined ? { column: Number(column) } : {}),
    });
    taken.push([index, index + m[0].length]);
  }
  for (const m of line.matchAll(DIR_ONLY_RE)) {
    const index = m.index ?? 0;
    if (!free(index, index + m[0].length)) continue;
    out.push({ index, text: m[0], path: (m[1] ?? "").replace(/\/$/, "") });
  }
  return out.sort((a, b) => a.index - b.index);
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g;

/** Only web pages leave the app: http(s), nothing else (no file:, javascript:, custom schemes). */
export function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalize(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return ["..", ...parts];
      out.pop();
    } else out.push(p);
  }
  return out;
}

/**
 * A printed path as a project path (repo-relative, POSIX), or null when it is outside the
 * project. Relative paths are relative to the terminal's folder (`cwd`, absolute); `home`
 * expands "~/".
 */
export function projectPathOf(printed: string, cwd: string, root: string, home?: string): string | null {
  let abs: string;
  if (printed.startsWith("/")) abs = printed;
  else if (printed.startsWith("~/")) {
    if (!home) return null;
    abs = `${home.replace(/\/$/, "")}/${printed.slice(2)}`;
  } else abs = `${cwd.replace(/\/$/, "")}/${printed}`;
  const parts = normalize(abs.split("/"));
  if (parts[0] === "..") return null;
  const rootParts = normalize(root.split("/"));
  if (parts.length < rootParts.length) return null;
  for (let i = 0; i < rootParts.length; i += 1) if (parts[i] !== rootParts[i]) return null;
  const rel = parts.slice(rootParts.length).join("/");
  return rel === "" ? null : rel;
}
