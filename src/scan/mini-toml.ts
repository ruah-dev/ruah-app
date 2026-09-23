// Tiny TOML subset reader for the scanner (no dependency, by design).
//
// Enough for pyproject.toml and Cargo.toml: [tables], [[arrays of tables]],
// dotted/quoted keys, basic and literal strings (single- and multi-line),
// arrays spanning lines, inline tables, numbers, booleans. Dates stay strings.
// Malformed input yields whatever was parsed so far — it never throws.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let pos = 0;
  const n = src.length;

  const peek = (): string => src[pos] ?? "";
  const skipWs = (newlines: boolean): void => {
    while (pos < n) {
      const c = src[pos];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) pos++;
      else if (c === "#") {
        while (pos < n && src[pos] !== "\n") pos++;
      } else break;
    }
  };
  const skipLine = (): void => {
    while (pos < n && src[pos] !== "\n") pos++;
  };

  const parseString = (): string => {
    const q = peek();
    if (src.startsWith(q.repeat(3), pos)) {
      pos += 3;
      if (src[pos] === "\n") pos++;
      const end = src.indexOf(q.repeat(3), pos);
      const raw = src.slice(pos, end === -1 ? n : end);
      pos = end === -1 ? n : end + 3;
      return q === '"' ? unescape(raw) : raw;
    }
    pos++;
    let out = "";
    while (pos < n && src[pos] !== q && src[pos] !== "\n") {
      if (q === '"' && src[pos] === "\\") {
        out += src.slice(pos, pos + 2);
        pos += 2;
      } else {
        out += src[pos];
        pos++;
      }
    }
    pos++;
    return q === '"' ? unescape(out) : out;
  };

  const parseKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipWs(false);
      const c = peek();
      if (c === '"' || c === "'") parts.push(parseString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(pos, pos + 256));
        if (m === null) break;
        parts.push(m[0]);
        pos += m[0].length;
      }
      skipWs(false);
      if (peek() === ".") pos++;
      else break;
    }
    return parts;
  };

  const parseValue = (): TomlValue => {
    skipWs(false);
    const c = peek();
    if (c === '"' || c === "'") return parseString();
    if (c === "[") {
      pos++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipWs(true);
        if (peek() === "]" || pos >= n) {
          pos++;
          return arr;
        }
        arr.push(parseValue());
        skipWs(true);
        if (peek() === ",") pos++;
      }
    }
    if (c === "{") {
      pos++;
      const tbl: TomlTable = {};
      for (;;) {
        skipWs(false);
        if (peek() === "}" || pos >= n || peek() === "\n") {
          pos++;
          return tbl;
        }
        const key = parseKey();
        skipWs(false);
        if (peek() !== "=") {
          pos++;
          continue;
        }
        pos++;
        setPath(tbl, key, parseValue());
        skipWs(false);
        if (peek() === ",") pos++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(pos, pos + 256));
    const tok = m?.[0] ?? "";
    pos += Math.max(tok.length, 1);
    if (tok === "true") return true;
    if (tok === "false") return false;
    const num = Number(tok.replaceAll("_", ""));
    return tok !== "" && Number.isFinite(num) ? num : tok;
  };

  let current: TomlTable = root;
  while (pos < n) {
    skipWs(true);
    if (pos >= n) break;
    if (peek() === "[") {
      const isArray = src[pos + 1] === "[";
      pos += isArray ? 2 : 1;
      const key = parseKey();
      skipLine();
      current = isArray ? pushArrayTable(root, key) : ensureTable(root, key);
      continue;
    }
    const key = parseKey();
    skipWs(false);
    if (key.length === 0 || peek() !== "=") {
      skipLine();
      continue;
    }
    pos++;
    setPath(current, key, parseValue());
    skipLine();
  }
  return root;
}

function unescape(s: string): string {
  return s.replace(/\\(["\\nt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

function ensureTable(root: TomlTable, keys: string[]): TomlTable {
  let t = root;
  for (const k of keys) {
    const cur = t[k];
    if (Array.isArray(cur)) {
      const last = cur[cur.length - 1];
      if (isTable(last)) {
        t = last;
        continue;
      }
    }
    if (!isTable(cur)) t[k] = {};
    t = t[k] as TomlTable;
  }
  return t;
}

function pushArrayTable(root: TomlTable, keys: string[]): TomlTable {
  const parent = ensureTable(root, keys.slice(0, -1));
  const last = keys[keys.length - 1] ?? "";
  const arr = Array.isArray(parent[last]) ? (parent[last] as TomlValue[]) : [];
  parent[last] = arr;
  const tbl: TomlTable = {};
  arr.push(tbl);
  return tbl;
}

function setPath(t: TomlTable, keys: string[], v: TomlValue): void {
  if (keys.length === 0) return;
  const parent = ensureTable(t, keys.slice(0, -1));
  parent[keys[keys.length - 1] ?? ""] = v;
}

export function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function tomlGet(t: TomlValue | undefined, ...keys: string[]): TomlValue | undefined {
  let cur: TomlValue | undefined = t;
  for (const k of keys) {
    if (!isTable(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function tomlString(v: TomlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function tomlStrings(v: TomlValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
