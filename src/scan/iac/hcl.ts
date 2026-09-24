// Tiny HCL reader for Terraform / OpenTofu files (no dependency, by design —
// same stance as mini-yaml.ts / mini-toml.ts).
//
// It understands the structure the scanner needs and nothing more: blocks
// (`type "label" "label" { … }`, nested, one-line bodies), attributes
// (`name = <expression>`), comments (#, //, /* */), strings with `${…}` /
// `%{…}` templates, heredocs (<<EOF, <<-EOF) and multi-line bracketed
// expressions. Expressions are not evaluated: every attribute keeps its raw
// source text (for reference extraction) and, when it is a plain literal, its
// value. Lines are 1-based. It never throws; malformed input degrades to
// fewer blocks.

export interface HclAttr {
  name: string;
  raw: string; // expression source, trimmed
  line: number; // 1-based
  value?: string; // plain literal: unquoted string without templates, number, bool
}

export interface HclBlock {
  type: string;
  labels: string[];
  line: number; // 1-based line of the block header
  endLine: number;
  attrs: Record<string, HclAttr>;
  blocks: HclBlock[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_-]/;

export function parseHcl(src: string): HclBlock[] {
  let i = 0;
  let line = 1;
  const n = src.length;

  const advance = (): string => {
    const c = src[i] ?? "";
    if (c === "\n") line++;
    i++;
    return c;
  };

  const skipLineComment = (): void => {
    while (i < n && src[i] !== "\n") i++;
  };
  const skipBlockComment = (): void => {
    i += 2;
    while (i < n && !(src[i] === "*" && src[i + 1] === "/")) advance();
    i += 2;
  };

  // Consumes a quoted string starting at the opening quote.
  const readString = (): void => {
    advance(); // "
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        advance();
        advance();
      } else if ((c === "$" || c === "%") && src[i + 1] === "{") {
        advance();
        readBraced();
      } else if (c === '"') {
        advance();
        return;
      } else if (c === "\n") {
        return; // unterminated: stop at the line end
      } else {
        advance();
      }
    }
  };

  // Consumes a `{ … }` template interpolation (or an object in an expression) with nested strings.
  const readBraced = (): void => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        readString();
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth <= 0) {
          advance();
          return;
        }
      }
      advance();
    }
  };

  // Heredoc: `<<EOF` / `<<-EOF` … a line holding only EOF.
  const readHeredoc = (): void => {
    const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i, i + 80));
    if (m === null) {
      advance();
      return;
    }
    const marker = m[1] ?? "";
    i += m[0].length;
    while (i < n) {
      skipLineComment(); // rest of the opening line
      if (i >= n) return;
      advance(); // newline
      const end = src.indexOf("\n", i);
      const text = src.slice(i, end === -1 ? n : end);
      if (text.trim() === marker) {
        i = end === -1 ? n : end;
        return;
      }
    }
  };

  // Reads an attribute expression up to its end (newline / `}` at depth 0).
  const readExpr = (): string => {
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        readString();
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && /[A-Za-z_-]/.test(src[i + 2] ?? "")) {
        readHeredoc();
        continue;
      }
      if (c === "#" || (c === "/" && src[i + 1] === "/")) {
        if (depth === 0) break;
        skipLineComment();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        skipBlockComment();
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break; // closes the enclosing block (one-line bodies)
        depth--;
      } else if (c === "\n" && depth === 0) break;
      advance();
    }
    return src.slice(start, i).trim();
  };

  const skipSpaceSameLine = (): void => {
    while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\r")) i++;
  };

  const readIdent = (): string => {
    const start = i;
    while (i < n && IDENT.test(src[i] ?? "")) i++;
    return src.slice(start, i);
  };

  const parseBody = (closing: boolean): { attrs: Record<string, HclAttr>; blocks: HclBlock[] } => {
    const attrs: Record<string, HclAttr> = {};
    const blocks: HclBlock[] = [];
    while (i < n) {
      const c = src[i] ?? "";
      if (c === "\n" || c === " " || c === "\t" || c === "\r" || c === ",") {
        advance();
        continue;
      }
      if (c === "#" || (c === "/" && src[i + 1] === "/")) {
        skipLineComment();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        skipBlockComment();
        continue;
      }
      if (c === "}") {
        advance();
        if (closing) return { attrs, blocks };
        continue;
      }
      if (IDENT_START.test(c) || c === '"') {
        const startLine = line;
        const name = c === '"' ? unquoteLiteral(readQuoted()) : readIdent();
        skipSpaceSameLine();
        if (src[i] === "=" && src[i + 1] !== "=") {
          advance();
          skipSpaceSameLine();
          const raw = readExpr();
          const value = literalValue(raw);
          attrs[name] = { name, raw, line: startLine, ...(value !== undefined ? { value } : {}) };
          continue;
        }
        // Block header: labels until "{".
        const labels: string[] = [];
        let ok = true;
        while (i < n) {
          skipSpaceSameLine();
          const d = src[i];
          if (d === "{") break;
          if (d === '"') labels.push(unquoteLiteral(readQuoted()));
          else if (d !== undefined && IDENT_START.test(d)) labels.push(readIdent());
          else {
            ok = false;
            break;
          }
        }
        if (!ok || src[i] !== "{") {
          skipLineComment();
          continue;
        }
        advance(); // {
        const body = parseBody(true);
        blocks.push({ type: name, labels, line: startLine, endLine: line, attrs: body.attrs, blocks: body.blocks });
        continue;
      }
      // Anything else (stray tokens): skip the line.
      skipLineComment();
    }
    return { attrs, blocks };
  };

  const readQuoted = (): string => {
    const start = i;
    readString();
    return src.slice(start, i);
  };

  try {
    return parseBody(false).blocks;
  } catch {
    return [];
  }
}

function unquoteLiteral(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/\\"/g, '"') : t;
}

function literalValue(raw: string): string | undefined {
  if (/^"(?:[^"\\$%]|\\.|\$(?!\{)|%(?!\{))*"$/.test(raw)) return unquoteLiteral(raw);
  if (/^-?\d+(\.\d+)?$/.test(raw) || raw === "true" || raw === "false") return raw;
  return undefined;
}

/** Every attribute's raw text in a block and its nested blocks (reference extraction). */
export function blockText(b: HclBlock): string {
  const parts: string[] = Object.values(b.attrs).map((a) => a.raw);
  for (const c of b.blocks) parts.push(blockText(c));
  return parts.join("\n");
}

/** First attribute named `name` in the block or its nested blocks (depth-first), for settings like `node_count`. */
export function findAttr(b: HclBlock, name: string, depth = 2): HclAttr | undefined {
  const own = b.attrs[name];
  if (own !== undefined) return own;
  if (depth <= 0) return undefined;
  for (const c of b.blocks) {
    const hit = findAttr(c, name, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// `*.tf.json`: the JSON syntax of the same structure. Top-level keys are block
// types; label levels follow the Terraform JSON spec (resource/data: 2 labels,
// module/variable/output/provider: 1, locals/terraform: 0). Line numbers are
// found by searching the source for the innermost label.
const JSON_LABELS: Record<string, number> = { resource: 2, data: 2, module: 1, variable: 1, output: 1, provider: 1, locals: 0, terraform: 0 };

export function parseHclJson(src: string): HclBlock[] {
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const lineOf = (needle: string): number => {
    const idx = src.indexOf(`"${needle}"`);
    return idx === -1 ? 1 : src.slice(0, idx).split("\n").length;
  };
  const toBlock = (type: string, labels: string[], body: unknown): HclBlock => {
    const attrs: Record<string, HclAttr> = {};
    const blocks: HclBlock[] = [];
    const line = lineOf(labels[labels.length - 1] ?? type);
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v) && ["container", "metadata", "spec", "template", "tags", "settings"].includes(k)) {
          blocks.push(toBlock(k, [], v));
          continue;
        }
        const raw = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "";
        const value = typeof v === "string" && !v.includes("${") ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
        attrs[k] = { name: k, raw, line, ...(value !== undefined ? { value } : {}) };
      }
    }
    return { type, labels, line, endLine: line, attrs, blocks };
  };
  const out: HclBlock[] = [];
  const walk = (type: string, value: unknown, labels: string[], remaining: number): void => {
    if (remaining === 0) {
      for (const body of Array.isArray(value) ? value : [value]) out.push(toBlock(type, labels, body));
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(type, v, [...labels, k], remaining - 1);
  };
  for (const [type, value] of Object.entries(doc as Record<string, unknown>)) {
    const depth = JSON_LABELS[type];
    if (depth !== undefined) walk(type, value, [], depth);
  }
  return out;
}
