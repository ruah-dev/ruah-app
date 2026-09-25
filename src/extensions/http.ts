// src/extensions/http.ts — CONTRACTS §15.3 endpoints under /api/extensions.
// Every POST passes the same Origin check as /ws (403 otherwise: a web page
// open in the browser must not add or enable an extension on this machine).
// Bodies are JSON (≤ 64 KiB) validated with zod. Secret values are accepted
// on POST /api/extensions/secret only, stored in the Keychain, never echoed.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import {
  AddExtensionBodySchema,
  DeleteSecretBodySchema,
  DisableExtensionBodySchema,
  EXTENSION_AGENTS,
  EnableExtensionBodySchema,
  ExtensionRefBodySchema,
  InstallIntoBodySchema,
  RemoveExtensionBodySchema,
  SetSecretBodySchema,
  type ExtensionAgent,
} from "../contracts/extensions.js";
import { ExtensionError, isExtensionAgent } from "./model.js";
import type { ExtensionsService, ProjectRef } from "./service.js";

const MAX_BODY_BYTES = 64 * 1024;
const PREFIX = "/api/extensions";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ExtensionError(413, "request body exceeds 64 KiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseBody<T extends z.ZodTypeAny>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  const raw = await readBody(req);
  let value: unknown;
  try {
    value = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new ExtensionError(400, "body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Never echo a received value (it may be a secret): path + message only.
    throw new ExtensionError(400, `invalid body: ${issue !== undefined ? `${issue.path.join(".") || "body"}: ${issue.message}` : "unknown"}`);
  }
  return parsed.data as z.infer<T>;
}

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof ExtensionError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

function agentsParam(url: URL): ExtensionAgent[] | undefined {
  const raw = url.searchParams.getAll("agent").flatMap((a) => a.split(",")).map((a) => a.trim()).filter((a) => a.length > 0);
  if (raw.length === 0) return undefined;
  const bad = raw.find((a) => !isExtensionAgent(a));
  if (bad !== undefined) throw new ExtensionError(400, `unknown agent "${bad}" (expected ${EXTENSION_AGENTS.join(", ")})`);
  return raw as ExtensionAgent[];
}

/** Handles /api/extensions/* (true) or leaves the request to others (false). Without a service: 503. */
export function handleExtensionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: ExtensionsService | undefined,
  project: () => ProjectRef | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  if (req.method === "POST" && !originOk(req.headers.origin)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  if (service === undefined) {
    sendJson(res, 503, { error: "extensions are not available" });
    return true;
  }
  const sub = pathname.slice(PREFIX.length);
  void route(req, res, url, sub, service, project).catch((err: unknown) => fail(res, err));
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, sub: string, service: ExtensionsService, projectOf: () => ProjectRef | undefined): Promise<void> {
  const project = projectOf();
  const get = req.method === "GET";
  const post = req.method === "POST";
  switch (sub) {
    case "":
    case "/":
      if (!get) break;
      sendJson(res, 200, await service.list(project));
      return;
    case "/featured":
      if (!get) break;
      sendJson(res, 200, { featured: service.featured(project) });
      return;
    case "/discover":
      if (!get) break;
      sendJson(res, 200, { agents: service.discover(project, agentsParam(url)) });
      return;
    case "/preview": {
      if (!get) break;
      const agents = agentsParam(url);
      const agent = agents?.[0];
      if (agent === undefined) throw new ExtensionError(400, "agent is required");
      sendJson(res, 200, await service.preview(agent, project));
      return;
    }
    case "/add": {
      if (!post) break;
      const body = await parseBody(req, AddExtensionBodySchema);
      sendJson(res, 200, { extension: await service.add(body, project) });
      return;
    }
    case "/remove": {
      if (!post) break;
      const body = await parseBody(req, RemoveExtensionBodySchema);
      const result = await service.remove(body.id, body.scope, project, { ...(body.uninstall !== undefined ? { uninstall: body.uninstall } : {}) });
      sendJson(res, 200, { ok: true, notes: result.notes });
      return;
    }
    case "/enable": {
      if (!post) break;
      const body = await parseBody(req, EnableExtensionBodySchema);
      sendJson(res, 200, { extension: await service.enable(body.id, body.scope, body.agents, project) });
      return;
    }
    case "/disable": {
      if (!post) break;
      const body = await parseBody(req, DisableExtensionBodySchema);
      sendJson(res, 200, { extension: await service.disable(body.id, body.scope, body.agents, project) });
      return;
    }
    case "/fetch": {
      if (!post) break;
      const body = await parseBody(req, ExtensionRefBodySchema);
      sendJson(res, 200, { extension: await service.fetch(body.id, body.scope, project) });
      return;
    }
    case "/secret": {
      if (!post) break;
      const body = await parseBody(req, SetSecretBodySchema);
      await service.setSecret(body.id, body.scope, body.name, body.value, project);
      sendJson(res, 200, { ok: true });
      return;
    }
    case "/secret/delete": {
      if (!post) break;
      const body = await parseBody(req, DeleteSecretBodySchema);
      sendJson(res, 200, { ok: true, deleted: await service.deleteSecret(body.id, body.scope, body.name, project) });
      return;
    }
    case "/install-into": {
      if (!post) break;
      const body = await parseBody(req, InstallIntoBodySchema);
      const result = await service.installInto(body.id, body.scope, body.target, body.targetScope, project);
      sendJson(res, 200, { extension: result.extension, written: result.written, notes: result.notes });
      return;
    }
    default:
      sendJson(res, 404, { error: "not found" });
      return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}
