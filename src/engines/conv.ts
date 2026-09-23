// src/engines/conv.ts — detect OpenAPI-like specs on a node and run ruah conv.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchNode } from "../contracts/architecture.js";
import { runEngineJson, type EngineCliDeps } from "./cli.js";

const SPEC_NAMES = [
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.yml",
  "swagger.json",
];

export interface DetectedSpec {
  path: string;
  kind: "openapi" | "swagger" | "postman" | "graphql" | "har" | "unknown";
}

function kindOf(file: string): DetectedSpec["kind"] {
  const base = path.basename(file).toLowerCase();
  if (base.includes("openapi")) return "openapi";
  if (base.includes("swagger")) return "swagger";
  if (base.endsWith(".postman_collection.json") || base.includes("postman")) return "postman";
  if (base.endsWith(".graphql") || base.endsWith(".gql")) return "graphql";
  if (base.endsWith(".har")) return "har";
  return "unknown";
}

export function detectSpecsForNode(root: string, node: ArchNode): DetectedSpec[] {
  const found: DetectedSpec[] = [];
  const candidates: string[] = [];
  if (node.path) candidates.push(node.path);
  for (const f of node.files ?? []) candidates.push(f);

  for (const rel of candidates) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        const base = path.basename(rel).toLowerCase();
        if (
          SPEC_NAMES.includes(base) ||
          base.endsWith(".har") ||
          base.endsWith(".graphql") ||
          base.endsWith(".gql") ||
          base.endsWith(".postman_collection.json")
        ) {
          found.push({ path: rel, kind: kindOf(rel) });
        }
      } else if (st.isDirectory()) {
        for (const name of SPEC_NAMES) {
          const child = path.join(abs, name);
          if (fs.existsSync(child)) {
            found.push({ path: path.join(rel, name), kind: kindOf(name) });
          }
        }
      }
    } catch {
      // ignore missing paths
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return found.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
}

export async function runConv(options: {
  root: string;
  specPath: string;
  command: "inspect" | "curate" | "generate" | "validate";
  deps?: EngineCliDeps;
}): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const abs = path.isAbsolute(options.specPath) ? options.specPath : path.join(options.root, options.specPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, status: 404, error: `spec not found: ${options.specPath}` };
  }
  const args =
    options.command === "generate"
      ? ["generate", abs, "--json"]
      : [options.command, abs, "--json"];
  const result = await runEngineJson<unknown>("conv", args, {
    cwd: options.root,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
    timeoutMs: 180_000,
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, data: result.data };
}
