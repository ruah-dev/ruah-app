// Lightweight symbol outline for one source file (CONTRACTS.md §1.6): the
// declarations a reader navigates by — functions, React components and hooks,
// classes, types, route handlers — with their line ranges, plus "calls / uses /
// renders" edges between symbols of the same file.
//
// No parser, by design (like src/scan/detectors/imports.ts): strings and
// comments are masked out, bracket depth is tracked per line, and top-level
// declarations are recognised by regex at column 0 at depth 0. Good enough for
// navigation; never used for anything that must be exact.

export type SymbolKind =
  | "function"
  | "component"
  | "hook"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "route"
  | "method";

export interface CodeSymbol {
  /** Unique within the file; the part of the element id after `#`. */
  key: string;
  name: string;
  kind: SymbolKind;
  line: number; // 1-based, first line of the declaration (decorators excluded)
  endLine: number; // 1-based, inclusive
  exported: boolean;
  /** Extra label, e.g. "GET /users" for a route handler or the base class. */
  detail?: string;
}

export interface SymbolEdge {
  from: string; // symbol key
  to: string; // symbol key
  label: "calls" | "uses" | "renders";
}

export interface SymbolOutline {
  language: "js" | "python" | "go" | "rust" | "unknown";
  symbols: CodeSymbol[];
  edges: SymbolEdge[];
  truncated: boolean;
}

export const MAX_SYMBOLS = 80;
export const MAX_SYMBOL_EDGES = 160;

const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const JSX_FILE = /\.(tsx|jsx)$/;

export function outlineLanguage(file: string): SymbolOutline["language"] {
  if (JS_FILE.test(file)) return "js";
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".rs")) return "rust";
  return "unknown";
}

/** Whether `parseSymbols` understands this file (drives "can drill into a file"). */
export function hasOutline(file: string): boolean {
  return outlineLanguage(file) !== "unknown";
}

// ---------------------------------------------------------------------------
// masking: strings and comments become spaces (newlines kept) so bracket
// counting and identifier search only see code.

function maskC(text: string, opts: { template: boolean; rawBacktick: boolean; hashComments?: boolean }): string {
  const out = text.split("");
  const n = text.length;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (opts.hashComments === true && c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "'" && /\w/.test(text[i - 1] ?? "") && /\w/.test(d ?? "")) {
      i++; // an apostrophe in JSX text ("Don't"): a string never starts right after a word
    } else if (c === '"' || c === "'") {
      // Single-line strings only: a stray quote must not swallow the file.
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`" && (opts.template || opts.rawBacktick)) {
      let j = i + 1;
      while (j < n && text[j] !== "`") j += opts.template && text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function maskPython(text: string): string {
  const out = text.split("");
  const n = text.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if ((c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
      const end = text.indexOf(c.repeat(3), i + 3);
      const stop = end === -1 ? n : end + 3;
      blank(i + 3, stop - 3);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/** Bracket depth at the start of every line. */
function lineDepths(masked: string): number[] {
  const depths: number[] = [0];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "\n") depths.push(depth);
  }
  return depths;
}

const isBlank = (s: string): boolean => s.trim() === "";

/** End line (0-based, inclusive) of a top-level statement starting at `start`: the line before
 * the next column-0 statement at depth 0, minus trailing blank lines. */
function statementEnd(lines: string[], masked: string[], depths: number[], start: number, pythonLike: boolean): number {
  let j = start + 1;
  for (; j < lines.length; j++) {
    const m = masked[j] ?? "";
    if (isBlank(m)) continue;
    const first = m[0] ?? " ";
    if (first === " " || first === "\t") continue;
    if (pythonLike) break; // column 0 ends a Python block
    if ((depths[j] ?? 0) !== 0) continue;
    if (first === "}" || first === ")" || first === "]" || first === ".") continue;
    break;
  }
  let end = j - 1;
  // Trailing blank lines, and decorators / doc comments of the next declaration.
  while (end > start && (isBlank(masked[end] ?? "") || /^\s*@/.test(lines[end] ?? ""))) end--;
  return end;
}

// ---------------------------------------------------------------------------
// JS / TS

const ID = "[A-Za-z_$][\\w$]*";
const RE_JS_FUNCTION = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})?`);
const RE_JS_CLASS = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})(?:\\s*<[^>{]*>)?(?:\\s+extends\\s+([\\w$.]+))?`);
const RE_JS_TYPE = new RegExp(`^(export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\b`);
const RE_JS_INTERFACE = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?interface\\s+(${ID})`);
const RE_JS_ENUM = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`);
const RE_JS_VAR = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]*)?=\\s*(.*)$`);
const RE_JS_ROUTE = /^\s*(?:[\w$]+)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])([^'"`]+)\2/;
const RE_FILE_ROUTE = /\bcreate(?:File|Root|Lazy)?Route\s*\(\s*(['"`])([^'"`]*)\1/;
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function isPascal(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

function functionishRhs(rhs: string): boolean {
  return (
    /^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>|<[^>]*>\s*\()/.test(rhs) ||
    // Effect-style definitions: Effect.fn("name")(function* …), Effect.gen(function* …).
    /^[\w$]+\.(fn|fnUntraced|gen)\s*[(<]/.test(rhs)
  );
}

function jsSymbols(file: string, text: string): CodeSymbol[] {
  const masked = maskC(text, { template: true, rawBacktick: false });
  const lines = text.split("\n");
  const mlines = masked.split("\n");
  const depths = lineDepths(masked);
  const jsx = JSX_FILE.test(file);
  const routeFile = /(^|\/)route\.(ts|js|mts|mjs)$/.test(file);
  const out: CodeSymbol[] = [];
  for (let i = 0; i < mlines.length; i++) {
    const m = mlines[i] ?? "";
    const raw = lines[i] ?? "";
    if ((depths[i] ?? 0) !== 0) continue;
    const first = m[0] ?? " ";
    // Top-level route registrations: `app.get("/x", …)`, `router.post(…)`.
    const route = RE_JS_ROUTE.exec(raw);
    if (route !== null) {
      const verb = (route[1] ?? "").toUpperCase();
      out.push({ key: "", name: `${verb === "ALL" ? "ANY" : verb} ${route[3] ?? ""}`, kind: "route", line: i + 1, endLine: statementEnd(lines, mlines, depths, i, false) + 1, exported: false });
      continue;
    }
    if (first === " " || first === "\t" || isBlank(m)) continue;
    const end = (): number => statementEnd(lines, mlines, depths, i, false) + 1;
    let r: RegExpExecArray | null;
    if ((r = RE_JS_FUNCTION.exec(m)) !== null) {
      const name = r[2] ?? "default";
      const exported = r[1] !== undefined;
      let kind: SymbolKind = "function";
      let detail: string | undefined;
      if (routeFile && HTTP_VERBS.has(name)) {
        kind = "route";
        detail = `${name} handler`;
      } else if (/^use[A-Z]/.test(name)) kind = "hook";
      else if (isPascal(name) && jsx) kind = "component";
      out.push({ key: "", name, kind, line: i + 1, endLine: end(), exported, ...(detail !== undefined ? { detail } : {}) });
    } else if ((r = RE_JS_CLASS.exec(m)) !== null) {
      const base = r[3];
      const component = base !== undefined && /(^|\.)(Pure)?Component$/.test(base);
      out.push({ key: "", name: r[2] ?? "default", kind: component ? "component" : "class", line: i + 1, endLine: end(), exported: r[1] !== undefined, ...(base !== undefined ? { detail: `extends ${base}` } : {}) });
    } else if ((r = RE_JS_INTERFACE.exec(m)) !== null) {
      out.push({ key: "", name: r[2] ?? "", kind: "interface", line: i + 1, endLine: end(), exported: r[1] !== undefined });
    } else if ((r = RE_JS_TYPE.exec(m)) !== null) {
      out.push({ key: "", name: r[2] ?? "", kind: "type", line: i + 1, endLine: end(), exported: r[1] !== undefined });
    } else if ((r = RE_JS_ENUM.exec(m)) !== null) {
      out.push({ key: "", name: r[2] ?? "", kind: "enum", line: i + 1, endLine: end(), exported: r[1] !== undefined });
    } else if ((r = RE_JS_VAR.exec(m)) !== null) {
      const name = r[2] ?? "";
      const exported = r[1] !== undefined;
      const rhs = (r[3] ?? "").trim();
      const fileRoute = RE_FILE_ROUTE.exec(raw);
      let kind: SymbolKind | null = null;
      let detail: string | undefined;
      if (fileRoute !== null) {
        kind = "route";
        detail = fileRoute[2] === "" ? "route" : `route ${fileRoute[2]}`;
      } else if (/^(React\.)?(memo|forwardRef|lazy)\s*[(<]/.test(rhs) || /^styled[.(]/.test(rhs)) kind = "component";
      else if (functionishRhs(rhs)) {
        kind = /^use[A-Z]/.test(name) ? "hook" : isPascal(name) && jsx ? "component" : "function";
      } else if (exported) kind = "const";
      if (kind === null) continue; // private plain values are noise
      out.push({ key: "", name, kind, line: i + 1, endLine: end(), exported, ...(detail !== undefined ? { detail } : {}) });
    } else if (/^export\s+default\s+/.test(m)) {
      out.push({ key: "", name: "default", kind: "const", line: i + 1, endLine: end(), exported: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python

function pythonSymbols(text: string): CodeSymbol[] {
  const masked = maskPython(text);
  const lines = text.split("\n");
  const mlines = masked.split("\n");
  const out: CodeSymbol[] = [];
  for (let i = 0; i < mlines.length; i++) {
    const m = mlines[i] ?? "";
    const r = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(m);
    if (r === null) continue;
    const name = r[2] ?? "";
    let kind: SymbolKind = r[1] === "class" ? "class" : "function";
    let detail: string | undefined;
    // Decorators directly above: `@app.get("/x")`, `@router.post(...)`.
    for (let k = i - 1; k >= 0 && /^@/.test(lines[k] ?? ""); k--) {
      const dec = /^@[\w.]*\.(get|post|put|patch|delete|route|api_route|websocket)\s*\(\s*['"]([^'"]*)['"]/.exec(lines[k] ?? "");
      if (dec !== null) {
        kind = "route";
        const verb = dec[1] === "route" || dec[1] === "api_route" ? "ANY" : (dec[1] ?? "").toUpperCase();
        detail = `${verb} ${dec[2] ?? ""}`;
      }
    }
    let end = i + 1;
    for (; end < mlines.length; end++) {
      const l = mlines[end] ?? "";
      if (isBlank(l)) continue;
      if (!/^[ \t]/.test(l)) break;
    }
    let last = end - 1;
    while (last > i && (isBlank(mlines[last] ?? "") || /^@/.test(lines[last] ?? ""))) last--;
    out.push({ key: "", name, kind, line: i + 1, endLine: last + 1, exported: !name.startsWith("_"), ...(detail !== undefined ? { detail } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Go / Rust (basic)

function goSymbols(text: string): CodeSymbol[] {
  const masked = maskC(text, { template: false, rawBacktick: true });
  const lines = text.split("\n");
  const mlines = masked.split("\n");
  const depths = lineDepths(masked);
  const out: CodeSymbol[] = [];
  for (let i = 0; i < mlines.length; i++) {
    const m = mlines[i] ?? "";
    if ((depths[i] ?? 0) !== 0) continue;
    let r: RegExpExecArray | null;
    let sym: Omit<CodeSymbol, "key" | "endLine"> | null = null;
    if ((r = /^func\s+(\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*)?(\w+)/.exec(m)) !== null) {
      const name = r[3] ?? "";
      sym = { name: r[2] !== undefined ? `${r[2]}.${name}` : name, kind: r[1] !== undefined ? "method" : "function", line: i + 1, exported: /^[A-Z]/.test(name) };
    } else if ((r = /^type\s+(\w+)\s+(struct|interface)?/.exec(m)) !== null) {
      const name = r[1] ?? "";
      sym = { name, kind: r[2] === "struct" ? "class" : r[2] === "interface" ? "interface" : "type", line: i + 1, exported: /^[A-Z]/.test(name) };
    }
    if (sym !== null) out.push({ key: "", ...sym, endLine: statementEnd(lines, mlines, depths, i, false) + 1 });
  }
  return out;
}

function rustSymbols(text: string): CodeSymbol[] {
  const masked = maskC(text, { template: false, rawBacktick: false });
  const lines = text.split("\n");
  const mlines = masked.split("\n");
  const depths = lineDepths(masked);
  const out: CodeSymbol[] = [];
  for (let i = 0; i < mlines.length; i++) {
    const m = mlines[i] ?? "";
    if ((depths[i] ?? 0) !== 0) continue;
    const r = /^(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|type)\s+(\w+)/.exec(m);
    if (r === null) continue;
    const kind: SymbolKind = r[2] === "fn" ? "function" : r[2] === "struct" ? "class" : r[2] === "enum" ? "enum" : r[2] === "trait" ? "interface" : "type";
    out.push({ key: "", name: r[3] ?? "", kind, line: i + 1, endLine: statementEnd(lines, mlines, depths, i, false) + 1, exported: r[1] !== undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// edges between symbols of the same file

function symbolEdges(language: SymbolOutline["language"], text: string, symbols: CodeSymbol[]): SymbolEdge[] {
  const named = symbols.filter((s) => /^[A-Za-z_$][\w$]*$/.test(s.name) && s.name !== "default");
  if (named.length === 0) return [];
  const byName = new Map<string, CodeSymbol>();
  for (const s of named) if (!byName.has(s.name)) byName.set(s.name, s);
  const masked =
    language === "python" ? maskPython(text) : maskC(text, { template: language === "js", rawBacktick: language === "go" });
  const mlines = masked.split("\n");
  const lines = text.split("\n");
  const escape = (s: string): string => s.replace(/[$]/g, "\\$");
  const re = new RegExp(`(?<![\\w$.])(${[...byName.keys()].map(escape).join("|")})(?![\\w$])`, "g");
  const edges: SymbolEdge[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    const body = mlines.slice(s.line - 1, s.endLine).join("\n");
    const rawBody = lines.slice(s.line - 1, s.endLine).join("\n");
    for (const m of body.matchAll(re)) {
      const target = byName.get(m[1] ?? "");
      if (target === undefined || target.key === s.key) continue;
      const id = `${s.key}\u0000${target.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const label: SymbolEdge["label"] =
        target.kind === "component" && new RegExp(`<${escape(target.name)}[\\s/>]`).test(rawBody)
          ? "renders"
          : target.kind === "function" || target.kind === "hook" || target.kind === "method" || target.kind === "route"
            ? "calls"
            : "uses";
      edges.push({ from: s.key, to: target.key, label });
      if (edges.length >= MAX_SYMBOL_EDGES) return edges;
    }
  }
  return edges;
}

/** Symbols of one file, in source order, with unique keys (name, then name~2, …). */
export function parseSymbols(file: string, text: string): SymbolOutline {
  const language = outlineLanguage(file);
  let symbols: CodeSymbol[] =
    language === "js" ? jsSymbols(file, text)
    : language === "python" ? pythonSymbols(text)
    : language === "go" ? goSymbols(text)
    : language === "rust" ? rustSymbols(text)
    : [];
  const truncated = symbols.length > MAX_SYMBOLS;
  if (truncated) {
    // Keep exported symbols first (they are the file's interface), then source order.
    const keep = new Set([...symbols].sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line).slice(0, MAX_SYMBOLS));
    symbols = symbols.filter((s) => keep.has(s));
  }
  const used = new Map<string, number>();
  for (const s of symbols) {
    const base = s.name.replace(/[\s#]+/g, " ").trim() || "symbol";
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    s.key = n === 1 ? base : `${base}~${n}`;
    if (s.endLine < s.line) s.endLine = s.line;
  }
  return { language, symbols, edges: symbolEdges(language, text, symbols), truncated };
}
