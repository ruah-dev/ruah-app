// CONTRACTS.md §2.3 — GET /api/architecture and GET /api/file.
import { ArchitectureSchema } from "./contract/index.js";
import type { Architecture } from "./contract/index.js";
import type { CodeFile } from "./graphTypes.js";

export function httpOriginFrom(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "wss:") return `https://${url.host}`;
    if (url.protocol === "ws:") return `http://${url.host}`;
    return null;
  } catch {
    return null;
  }
}

export async function fetchArchitecture(origin: string): Promise<Architecture | null> {
  try {
    const res = await fetch(`${origin}/api/architecture`);
    if (!res.ok) return null;
    const parsed = ArchitectureSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function fetchFile(origin: string, path: string): Promise<CodeFile | null> {
  try {
    const res = await fetch(`${origin}/api/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { path: p, lang, content } = body as { path?: unknown; lang?: unknown; content?: unknown };
    if (typeof p !== "string" || typeof content !== "string") return null;
    return {
      path: p,
      lang: typeof lang === "string" ? lang : "text",
      code: content,
    };
  } catch {
    return null;
  }
}

export async function copyContext(origin: string, nodeId: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/context/${encodeURIComponent(nodeId)}`);
    if (!res.ok) return false;
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
