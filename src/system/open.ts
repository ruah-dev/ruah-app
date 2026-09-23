// src/system/open.ts — opening a folder that holds ruah.system.json as a
// project (CONTRACTS §5.3 "open", docs/MULTI-REPO.md): rebuild the system
// architecture (keeping hand edits), write it next to the system file, and
// return a store whose paths ("<repoId>/<rel>") resolve into each repo.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { createArchitectureStore } from "../serve/architecture-store.js";
import { ProjectError, type OpenSystemProject } from "../projects/service.js";
import { buildSystemArchitecture } from "./build.js";
import { loadSystem, resolveSystemPath } from "./config.js";
import { registerSystemRoots } from "./roots.js";

function readPrevious(file: string): Architecture | null {
  if (!fs.existsSync(file)) return null;
  try {
    const r = validateArchitecture(JSON.parse(fs.readFileSync(file, "utf8")), null);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export function makeOpenSystemProject(version: string, options: { watch?: boolean } = {}): OpenSystemProject {
  return async (root) => {
    let sys;
    try {
      sys = loadSystem(root);
    } catch (err) {
      throw new ProjectError(422, `invalid ruah.system.json: ${(err as Error).message}`);
    }
    const out = path.join(sys.dir, "architecture.json");
    const result = buildSystemArchitecture(sys, { version, now: new Date(), previous: readPrevious(out), outFile: out });
    const checked = validateArchitecture(result.architecture, null);
    if (!checked.ok) throw new ProjectError(422, `system architecture failed validation: ${checked.errors[0] ?? ""}`);
    const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(result.architecture, null, 2)}\n`);
    fs.renameSync(tmp, out);
    registerSystemRoots(sys.dir, sys.repos.map((r) => r.root));
    const store = createArchitectureStore(out, {
      watch: options.watch ?? true,
      resolvePath: (rel) => {
        const hit = resolveSystemPath(sys, rel);
        return hit === null ? null : { abs: hit.abs, root: hit.root };
      },
    });
    await store.load();
    return { store, name: sys.name };
  };
}
