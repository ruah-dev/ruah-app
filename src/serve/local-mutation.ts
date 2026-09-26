// src/serve/local-mutation.ts — the strict rule for requests that change what
// Ruah may do on the user's behalf (agent extensions §17, the app-login opt-in
// §21.1). Stricter than the /ws Origin rule, which accepts any loopback port:
//   - the peer is a loopback address and the Host header a loopback name
//     (a DNS-rebound page carries its own host name; a network peer of a
//     --host 0.0.0.0 daemon is refused);
//   - Content-Type is application/json: a cross-site page cannot send that
//     without a CORS preflight, which the daemon never grants (a text/plain
//     "simple" POST is refused);
//   - Sec-Fetch-Site, when sent, is same-origin (or none), and Origin, when
//     sent, is the Host's own origin and passes the /ws rule — so neither
//     another localhost port (a dev server in the Preview, a local app's
//     third-party script) nor an --allow-origin site can make the change.
// A missing Origin is a non-browser client (the CLI, curl, tests).
import type { IncomingMessage } from "node:http";

/** Same rules as src/terminal/gateway.ts (kept local: that module pulls in the terminal). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isLoopbackHostName(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/** True when the request carries no Origin (a non-browser client) or the Host's own origin. */
export function ownOrigin(req: Pick<IncomingMessage, "headers">): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Why a request that changes a protected setting is refused (status + message),
 * or undefined when it may proceed. `what` names the thing ("extensions") for
 * the message.
 */
export function localMutationRefusal(
  req: IncomingMessage,
  originOk: (origin: string | undefined) => boolean,
  what: string,
): { status: number; error: string } | undefined {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return { status: 403, error: `${what} can only be changed from this machine` };
  const host = hostnameOf(req.headers.host);
  if (host === undefined || !isLoopbackHostName(host)) return { status: 403, error: "host not allowed" };
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "content-type must be application/json" };
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return { status: 403, error: "cross-site request" };
  const origin = req.headers.origin;
  if (origin !== undefined && (!ownOrigin(req) || !originOk(origin))) {
    return { status: 403, error: `origin not allowed: ${what} can only be changed from the viewer this daemon serves` };
  }
  return undefined;
}
