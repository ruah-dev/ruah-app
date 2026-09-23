// Tiny YAML subset reader for the scanner (no dependency, by design).
//
// Enough for pnpm-workspace.yaml and docker-compose files: block mappings,
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
