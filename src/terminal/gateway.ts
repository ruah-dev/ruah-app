// Adapted from t3code apps/server/src/terminal/OutputProtocol.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
// (per-client output window with acknowledgements; here the window lives in
// TerminalManager as per-viewer unacked character counts that pause the PTY).
//
// The terminal's transport (CONTRACTS §7): GET /api/terminal/token and the
// /ws/terminal WebSocket. A terminal is arbitrary code execution as the user,
// so on top of the Origin check every /ws connection has, the socket needs a
// per-daemon random capability token that only a same-origin page can read:
//   - the token endpoint answers loopback peers only, with a loopback Host
//     header (DNS rebinding: a rebound hostname carries the attacker's name),
//     and refuses cross-site fetches (Origin must equal the Host's origin,
//     Sec-Fetch-Site must be same-origin/none); it sends no CORS headers, so a
//     cross-origin page cannot read the body either way;
//   - the socket checks peer, Host, Origin (same rule as /ws) and the token.
// When the daemon listens on a non-loopback address (--host), terminals are
// off unless --allow-remote-terminal was given; then remote peers are allowed
// but the Host must still be an IP literal, localhost or the --host value.
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { TerminalClientMessageSchema, type TerminalServerMessage } from "../contracts/terminal.js";
import { TerminalError, type TerminalManager, type TerminalSink } from "./manager.js";

export const TERMINAL_WS_PATH = "/ws/terminal";
export const TERMINAL_TOKEN_PATH = "/api/terminal/token";

export interface TerminalGatewayOptions {
  manager: TerminalManager;
  /** The address the daemon listens on (--host). */
  host: string;
  /** --allow-remote-terminal: terminals on a non-loopback --host. */
  allowRemote: boolean;
  /** Same rule as /ws (server.ts originAllowed). */
  originAllowed: (origin: string | undefined) => boolean;
  logger?: (line: string) => void;
  /** Fixed token (tests); default 32 random bytes per daemon. */
  token?: string;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function isLoopbackHostName(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_NAMES.has(h) || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Hostname of a Host header value ("127.0.0.1:4177", "[::1]:80", "localhost"). */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function sameToken(given: string | null | undefined, expected: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function refuseUpgrade(socket: Duplex, status: 401 | 403 | 404, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class TerminalGateway {
  readonly token: string;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  private readonly remoteBind: boolean;

  constructor(private readonly options: TerminalGatewayOptions) {
    this.token = options.token ?? randomBytes(32).toString("base64url");
    const bind = options.host.replace(/^\[|\]$/g, "");
    this.remoteBind = !(isLoopbackHostName(bind) || isLoopbackAddress(bind));
  }

  /** Why terminals are off for everyone (non-loopback --host without --allow-remote-terminal), else undefined. */
  disabledReason(): string | undefined {
    if (this.remoteBind && !this.options.allowRemote) {
      return `Terminals are disabled because the daemon listens on ${this.options.host}; restart it with --allow-remote-terminal to allow them (anyone who can reach the port and read the token gets a shell).`;
    }
    return undefined;
  }

  private peerAllowed(req: IncomingMessage): boolean {
    return isLoopbackAddress(req.socket.remoteAddress) || (this.remoteBind && this.options.allowRemote);
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const name = hostnameOf(req.headers.host);
    if (name === undefined) return false;
    if (isLoopbackHostName(name)) return true;
    if (!(this.remoteBind && this.options.allowRemote)) return false;
    return isIP(name) !== 0 || name === this.options.host.replace(/^\[|\]$/g, "");
  }

  /** Handles GET /api/terminal/token; false for any other path. */
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== TERMINAL_TOKEN_PATH) return false;
    if (req.method !== "GET") {
      reply(res, 405, { error: "GET only" });
      return true;
    }
    const disabled = this.disabledReason();
    if (disabled !== undefined) {
      reply(res, 403, { error: disabled });
      return true;
    }
    if (!this.peerAllowed(req)) {
      reply(res, 403, { error: "terminals are local only" });
      return true;
    }
    if (!this.hostAllowed(req)) {
      reply(res, 403, { error: "host not allowed" });
      return true;
    }
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      reply(res, 403, { error: "cross-site request" });
      return true;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin || !this.options.originAllowed(origin)) {
        reply(res, 403, { error: "origin not allowed" });
        return true;
      }
    }
    reply(res, 200, { token: this.token });
    return true;
  }

  /** Handles the /ws/terminal upgrade; false for any other path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    if (url.pathname !== TERMINAL_WS_PATH) return false;
    const log = (line: string): void => this.options.logger?.(`terminal: ${line}`);
    if (this.disabledReason() !== undefined) {
      log("rejected: disabled on a non-loopback host");
      refuseUpgrade(socket, 403, "Forbidden");
      return true;
    }
    if (!this.peerAllowed(req) || !this.hostAllowed(req)) {
      log(`rejected peer ${req.socket.remoteAddress ?? "?"} host ${req.headers.host ?? "(none)"}`);
      refuseUpgrade(socket, 403, "Forbidden");
      return true;
    }
    if (!this.options.originAllowed(req.headers.origin)) {
      log(`rejected origin ${req.headers.origin ?? "(none)"}`);
      refuseUpgrade(socket, 403, "Forbidden");
      return true;
    }
    if (!sameToken(url.searchParams.get("token"), this.token)) {
      log("rejected: missing or invalid token");
      refuseUpgrade(socket, 401, "Unauthorized");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    return true;
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }

  private connect(ws: WebSocket): void {
    const manager = this.options.manager;
    const send = (message: TerminalServerMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const sink: TerminalSink = send;
    const offChange = manager.onChange((projectId) => send({ type: "terminals", projectId, terminals: manager.list(projectId) }));
    ws.on("close", () => {
      offChange();
      manager.detachAll(sink);
    });

    void manager.availability().then((a) => {
      const projectId = manager.currentProjectId();
      if (a.available) send({ type: "ready", available: true, projectId, shell: a.shell });
      else send({ type: "ready", available: false, reason: a.reason, projectId });
      send({ type: "terminals", projectId, terminals: manager.list(projectId) });
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        send({ type: "error", message: "binary frames are not supported" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "invalid JSON" });
        return;
      }
      const checked = TerminalClientMessageSchema.safeParse(parsed);
      if (!checked.success) {
        const requestId = typeof (parsed as { requestId?: unknown })?.requestId === "string" ? (parsed as { requestId: string }).requestId : undefined;
        const issue = checked.error.issues[0];
        send({ type: "error", ...(requestId !== undefined ? { requestId } : {}), message: `invalid message: ${issue !== undefined ? `${issue.path.join(".") || "message"}: ${issue.message}` : "unknown"}` });
        return;
      }
      const message = checked.data;
      const fail = (err: unknown): void => {
        const text = err instanceof TerminalError || err instanceof Error ? err.message : String(err);
        send({
          type: "error",
          ...("requestId" in message && message.requestId !== undefined ? { requestId: message.requestId } : {}),
          ...("id" in message ? { id: message.id } : {}),
          message: text,
        });
      };
      try {
        switch (message.type) {
          case "create":
            manager
              .create({ cwd: message.cwd, nodeId: message.nodeId, cols: message.cols, rows: message.rows, title: message.title, input: message.input })
              .then((terminal) => send({ type: "created", requestId: message.requestId, terminal }), fail);
            return;
          case "list": {
            const projectId = message.projectId ?? manager.currentProjectId();
            send({ type: "terminals", projectId, terminals: manager.list(projectId), ...(message.requestId !== undefined ? { requestId: message.requestId } : {}) });
            return;
          }
          case "attach": {
            const { terminal, replay } = manager.attach(message.id, sink);
            send({ type: "attached", id: message.id, terminal, replay });
            if (terminal.status === "exited") send({ type: "exit", id: terminal.id, exitCode: terminal.exitCode, signal: terminal.signal });
            return;
          }
          case "detach":
            manager.detach(message.id, sink);
            return;
          case "input":
            manager.input(message.id, message.data);
            return;
          case "resize":
            manager.resize(message.id, message.cols, message.rows);
            return;
          case "kill":
            manager.kill(message.id);
            return;
          case "rename":
            manager.rename(message.id, message.title);
            return;
          case "clear":
            manager.clear(message.id);
            return;
          case "ack":
            manager.ack(message.id, sink, message.chars);
            return;
        }
      } catch (err) {
        fail(err);
      }
    });
  }
}
