// Tiny YAML subset reader for the scanner (no dependency, by design).
//
// Enough for pnpm-workspace.yaml, docker-compose, Kubernetes / Kustomize /
// Helm values, Ansible and CI files: block mappings,
// block sequences (including "- key: value" items), flow sequences/maps on one
// line, quoted and plain scalars, comments, and block scalars (| and >), whose
// text is kept verbatim. Anchors are stripped; aliases and merge keys are kept
// as plain strings. Anything it cannot understand becomes null or a string —
// it never throws.

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#][^:]*?)\s*:(?:\s+(.*)|$)/;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of inner) {
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "[" || c === "{") {
      depth++;
      cur += c;
    } else if (c === "]" || c === "}") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function scalar(raw: string): YamlValue {
  let t = raw.trim();
  if (t.startsWith("&")) t = t.replace(/^&\S+\s*/, "");
  if (t === "" || t === "~" || t === "null") return null;
  if (t.startsWith("[") && t.endsWith("]")) return splitFlow(t.slice(1, -1)).map(scalar);
  if (t.startsWith("{") && t.endsWith("}")) {
    const out: { [key: string]: YamlValue } = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/.exec(part);
      if (m !== null) out[unquote(m[1] ?? "")] = scalar(m[2] ?? "");
    }
    return out;
  }
  return unquote(t);
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const noTab = rawLine.replace(/\t/g, "  ");
    const text = stripComment(noTab).trimEnd();
    if (text.trim() === "" || /^(---|\.\.\.)(\s|$)/.test(text)) {
      // Keep blank lines only as separators; block scalars tolerate their absence.
      continue;
    }
    lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart() });
  }
  let i = 0;

  const isSeqItem = (l: Line): boolean => l.text === "-" || l.text.startsWith("- ");

  const parseNode = (minIndent: number): YamlValue => {
    const l = lines[i];
    if (l === undefined || l.indent < minIndent) return null;
    return isSeqItem(l) ? parseSeq(l.indent) : parseMap(l.indent);
  };

  const skipDeeper = (indent: number): string => {
    const parts: string[] = [];
    while (i < lines.length && (lines[i]?.indent ?? 0) > indent) {
      parts.push(lines[i]?.text ?? "");
      i++;
    }
    return parts.join("\n");
  };

  const parseSeq = (indent: number): YamlValue[] => {
    const out: YamlValue[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined || l.indent !== indent || !isSeqItem(l)) break;
      const rest = l.text.slice(1).trimStart();
      if (rest === "") {
        i++;
        out.push(parseNode(indent + 1));
      } else if (KEY_RE.test(rest) && !rest.startsWith("{") && !rest.startsWith("[")) {
        // "- key: value" starts a mapping whose keys align with `key`.
        lines[i] = { indent: indent + (l.text.length - rest.length), text: rest };
        out.push(parseMap(lines[i]?.indent ?? indent + 2));
      } else {
        i++;
        out.push(scalar(rest));
        if ((lines[i]?.indent ?? 0) > indent && !isSeqItem(lines[i] ?? { indent: 0, text: "" })) skipDeeper(indent);
      }
    }
    return out;
  };

  const parseMap = (indent: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = {};
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined || l.indent !== indent || isSeqItem(l)) break;
      const m = KEY_RE.exec(l.text);
      i++;
      if (m === null) {
        skipDeeper(indent);
        continue;
      }
      const key = unquote(m[1] ?? "");
      let val = (m[2] ?? "").trim();
      if (val.startsWith("&")) val = val.replace(/^&\S+\s*/, "");
      if (/^[|>][+-]?\d*$/.test(val)) {
        out[key] = skipDeeper(indent);
      } else if (val === "") {
        const next = lines[i];
        if (next !== undefined && next.indent > indent) out[key] = parseNode(indent + 1);
        else if (next !== undefined && next.indent === indent && isSeqItem(next)) out[key] = parseSeq(indent);
        else out[key] = null;
      } else {
        out[key] = scalar(val);
        // Plain multi-line scalars: swallow continuation lines.
        if ((lines[i]?.indent ?? 0) > indent) skipDeeper(indent);
      }
    }
    return out;
  };

  const first = lines[0];
  if (first === undefined) return null;
  return parseNode(first.indent);
}

export function yamlGet(v: YamlValue | undefined, key: string): YamlValue | undefined {
  if (v === null || v === undefined || typeof v === "string" || Array.isArray(v)) return undefined;
  return v[key];
}

export function yamlStrings(v: YamlValue | undefined): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

export function yamlKeys(v: YamlValue | undefined): string[] {
  if (v === null || v === undefined || typeof v === "string" || Array.isArray(v)) return [];
  return Object.keys(v);
}

/** Nested lookup: yamlPath(v, "spec", "template", "spec"). */
export function yamlPath(v: YamlValue | undefined, ...keys: string[]): YamlValue | undefined {
  let cur = v;
  for (const k of keys) cur = yamlGet(cur, k);
  return cur;
}

/** A scalar as a string (numbers and booleans are plain strings in this subset). */
export function yamlString(v: YamlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function yamlList(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : [];
}

export interface YamlDocument {
  text: string; // the document's lines (separator excluded), joined with "\n"
  start: number; // 0-based line index of the document's first line in the source
  end: number; // 0-based line index of its last line (inclusive)
}

// Splits a multi-document stream (Kubernetes manifests, Helm templates) on
// `---` / `...` separator lines. Documents holding only blanks and comments are
// dropped. Line indices refer to the original source, so callers can report
// `path:line` evidence without a position-aware parser.
export function splitYamlDocuments(src: string): YamlDocument[] {
  const lines = src.split(/\r?\n/);
  const docs: YamlDocument[] = [];
  let start = 0;
  const flush = (end: number): void => {
    if (end < start) return;
    const body = lines.slice(start, end + 1);
    if (body.some((l) => l.trim() !== "" && !l.trimStart().startsWith("#"))) docs.push({ text: body.join("\n"), start, end });
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^(---|\.\.\.)(\s|$)/.test(lines[i] ?? "")) {
      flush(i - 1);
      start = i + 1;
    }
  }
  flush(lines.length - 1);
  return docs;
}

/** First 0-based line index in [start, end] matching `re`, or undefined. */
export function findLine(lines: readonly string[], re: RegExp, start = 0, end = lines.length - 1): number | undefined {
  for (let i = Math.max(0, start); i <= Math.min(end, lines.length - 1); i++) if (re.test(lines[i] ?? "")) return i;
  return undefined;
}
