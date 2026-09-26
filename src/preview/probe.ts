// Ports and HTTP checks for the preview: is something listening, which port is
// free, does the URL answer and may it be shown in an iframe.
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { isLoopbackHostName } from "../terminal/gateway.js";

/** True when something accepts TCP connections on the port (IPv4 or IPv6 loopback). */
export async function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (open: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  const [v4, v6] = await Promise.all([tryHost("127.0.0.1"), tryHost("::1")]);
  return v4 || v6;
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * The first port at or above `start` that nothing listens on (a connect test —
 * macOS AirPlay holds *:5000 and a bind to 127.0.0.1 alone would still succeed)
 * and that can be bound. Throws after `span` ports.
 */
export async function findFreePort(start: number, span = 50): Promise<number> {
  for (let port = Math.max(1024, start); port < Math.min(65536, start + span); port += 1) {
    if (await isPortOpen(port, 200)) continue;
    if (await canBind(port, "127.0.0.1")) return port;
  }
  throw new Error(`no free port in ${start}–${start + span - 1}`);
}

/** Any free port chosen by the OS. */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type Framing = "ok" | "blocked" | "unknown";

/** Whether a page with these headers may be framed by another origin (the viewer). */
export function framingFromHeaders(headers: http.IncomingHttpHeaders): Framing {
  const xfo = headers["x-frame-options"];
  const xfoValue = (Array.isArray(xfo) ? xfo.join(",") : (xfo ?? "")).toLowerCase();
  if (xfoValue.includes("deny") || xfoValue.includes("sameorigin")) return "blocked";
  const csp = headers["content-security-policy"];
  const cspValue = Array.isArray(csp) ? csp.join(";") : (csp ?? "");
  const directive = cspValue
    .split(/[;,]/)
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (directive !== undefined) {
    const sources = directive.split(/\s+/).slice(1);
    const allowsAny = sources.some((s) => s === "*" || /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\*|:\d+)?$/i.test(s) || s === "http:" || s === "https:");
    if (!allowsAny) return "blocked";
  }
  return "ok";
}

export interface HttpCheck {
  ok: boolean;
  status?: number;
  framing: Framing;
  error?: string;
}

/** GET an http(s) URL; any HTTP answer (even 404 / 500) means the server is up. https on a loopback host (only) accepts self-signed certificates. */
export function checkHttp(url: string, timeoutMs = 2000): Promise<HttpCheck> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, framing: "unknown", error: "invalid URL" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      resolve({ ok: false, framing: "unknown", error: `not an http(s) URL (${parsed.protocol})` });
      return;
    }
    const secure = parsed.protocol === "https:";
    const loopback = isLoopbackHostName(parsed.hostname.replace(/^\[|\]$/g, ""));
    const get = secure ? https.get : http.get;
    let settled = false;
    const finish = (result: HttpCheck): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = get(
      parsed,
      {
        timeout: timeoutMs,
        headers: { accept: "text/html,*/*", "user-agent": "ruah-preview" },
        ...(secure && loopback ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        finish({ ok: true, status: res.statusCode ?? 0, framing: framingFromHeaders(res.headers) });
        res.resume();
        req.destroy();
      },
    );
    req.on("timeout", () => {
      finish({ ok: false, framing: "unknown", error: "timed out" });
      req.destroy();
    });
    req.on("error", (err) => finish({ ok: false, framing: "unknown", error: err.message }));
  });
}
