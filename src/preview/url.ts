// Finding the dev server's URL in its output (pure, tested in test/preview.test.ts).
//
// Dev servers print where they listen in many shapes: Vite / Astro / Storybook
// ("➜  Local:   http://localhost:5173/"), Next ("- Local: http://localhost:3000"),
// Django ("Starting development server at http://127.0.0.1:8000/"), Flask
// ("* Running on http://127.0.0.1:5000"), Puma ("* Listening on http://127.0.0.1:3000"),
// Expo ("Web is waiting on http://localhost:8081"), plain Node servers
// ("Server listening on port 3000"). Only local hosts count: telemetry and docs
// links are never the preview. Wildcard binds (0.0.0.0, ::) become localhost.

// CSI / OSC / other escape sequences, and stray control characters.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export interface UrlHit {
  url: string;
  port: number;
  /** Higher = more likely the page to show. */
  score: number;
}

const URL_RE = /\bhttps?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{2,5}))?(\/[^\s'"<>)\]]*)?/g;
const PORT_RE = /\b(?:listening|running|started|serving|server|available|ready|up)\b[^\n]{0,40}?\b(?:port|on)\s*[:=]?\s*:?(\d{2,5})\b/i;

function isLanIp(host: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host);
}

/** The host a browser on this machine should use; undefined = not a local address. */
export function localHost(host: string): { host: string; bonus: number } | undefined {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return { host, bonus: 3 };
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return { host: h, bonus: 3 };
  if (h === "::1") return { host: "[::1]", bonus: 2 };
  if (h === "0.0.0.0" || h === "::" || h === "") return { host: "localhost", bonus: 1 };
  if (isLanIp(h)) return { host: h, bonus: -2 };
  return undefined;
}

/** Local URLs (and "listening on port N") in one line of output, best first. */
export function findUrls(rawLine: string): UrlHit[] {
  const line = stripAnsi(rawLine);
  const hits: UrlHit[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const local = localHost(m[1] ?? "");
    if (local === undefined) continue;
    const secure = m[0].startsWith("https:");
    const port = m[2] !== undefined ? Number(m[2]) : secure ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const pathPart = (m[3] ?? "/").replace(/[.,;:]+$/, "") || "/";
    let score = local.bonus;
    if (/\blocal\b/i.test(line)) score += 3;
    if (/\bnetwork\b|\bexternal\b/i.test(line)) score -= 3;
    // Inspector / HMR sockets and API docs are never the page.
    if (/debugger|inspect|devtools|hmr|websocket|__/i.test(line) || pathPart.startsWith("/__")) score -= 4;
    if (/\/(docs|redoc|graphql|api)\b/.test(pathPart)) score -= 1;
    hits.push({ url: `${secure ? "https" : "http"}://${local.host}:${port}${pathPart}`, port, score });
  }
  if (hits.length === 0) {
    const m = PORT_RE.exec(line);
    const port = m !== null ? Number(m[1]) : Number.NaN;
    if (Number.isInteger(port) && port >= 80 && port <= 65535 && !/debugger|inspect/i.test(line)) {
      hits.push({ url: `http://localhost:${port}/`, port, score: 0 });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Splits streamed output into complete lines; `\r` (progress redraws) ends a line too. */
export class LineSplitter {
  private rest = "";

  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? "";
    // A line that never ends (a prompt, a spinner) still shows up after 4 KiB.
    if (this.rest.length > 4096) {
      parts.push(this.rest);
      this.rest = "";
    }
    return parts;
  }

  flush(): string[] {
    const rest = this.rest;
    this.rest = "";
    return rest.length > 0 ? [rest] : [];
  }
}

/** The line that best explains a crash (the last error-looking one), else the last non-empty line. */
export function crashReason(lines: readonly string[]): string | undefined {
  const tail = lines.slice(-80);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = (tail[i] ?? "").trim();
    if (/\b(error|exception|failed|cannot|can't|not found|EADDRINUSE|ENOENT|EACCES|panic|traceback)\b/i.test(line)) return line.slice(0, 300);
  }
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = (tail[i] ?? "").trim();
    if (line.length > 0) return line.slice(0, 300);
  }
  return undefined;
}
