// Dockerfile detector: the glue between code and images. Each Dockerfile
// (Dockerfile, Dockerfile.<name>, <name>.Dockerfile, Containerfile) yields its
// runtime base image, exposed ports, workdir and command, plus the hints the
// graph uses to find the code it packages: its directory, a name suffix
// (docker/Dockerfile.api → "api"), COPY sources and pnpm / turbo / npm
// workspace filters.
import type { ScanContext } from "../types.js";
import { dirname } from "../walk.js";
import { isFixturePath, normJoin, readCached, uniq, type DockerfileInfo, type InfraReport } from "./model.js";

const MAX_DOCKERFILES = 500;

export function isDockerfile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /^(Dockerfile|Containerfile)([.-][A-Za-z0-9_.-]+)?$/.test(base) || /\.(Dockerfile|dockerfile)$/.test(base);
}

export function parseDockerfile(file: string, text: string): DockerfileInfo {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const nameHint = /^(?:Dockerfile|Containerfile)[.-]([A-Za-z0-9_-]+)$/.exec(base)?.[1] ?? /^([A-Za-z0-9_-]+)\.[Dd]ockerfile$/.exec(base)?.[1];
  // Join continuation lines, keep the 1-based line of each instruction.
  const instr: { line: number; text: string }[] = [];
  let buf = "";
  let start = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (buf === "" && (l === "" || l.startsWith("#"))) return;
    if (buf === "") start = i + 1;
    if (l.endsWith("\\")) {
      buf += `${l.slice(0, -1)} `;
      return;
    }
    buf += l;
    instr.push({ line: start, text: buf });
    buf = "";
  });
  if (buf !== "") instr.push({ line: start, text: buf });
  const stages: string[] = [];
  const stageNames = new Set<string>();
  const expose: string[] = [];
  const copies: string[] = [];
  const filters: string[] = [];
  let workdir: string | undefined;
  let cmd: string | undefined;
  let firstLine = 1;
  const dir = dirname(file);
  for (const { line, text: t } of instr) {
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(t);
    if (m === null) continue;
    const op = (m[1] ?? "").toUpperCase();
    const args = m[2] ?? "";
    if (op === "FROM") {
      const parts = args.replace(/--platform=\S+\s*/, "").split(/\s+/);
      const image = parts[0] ?? "";
      const as = /\bAS\s+(\S+)/i.exec(args)?.[1];
      if (as !== undefined) stageNames.add(as.toLowerCase());
      if (stages.length === 0) firstLine = line;
      stages.push(stageNames.has(image.toLowerCase()) ? `stage:${image}` : image);
    } else if (op === "EXPOSE") {
      expose.push(...args.split(/\s+/).map((p) => p.replace(/\/tcp$/, "")).filter((p) => p !== "" && !p.startsWith("$")));
    } else if (op === "WORKDIR") {
      workdir = args.trim();
    } else if (op === "CMD" || op === "ENTRYPOINT") {
      cmd = args.replace(/^\[|\]$/g, "").replace(/",\s*"/g, " ").replace(/"/g, "").trim().slice(0, 80);
    } else if (op === "COPY" || op === "ADD") {
      if (/--from=/.test(args)) continue;
      const parts = args.replace(/--[a-z-]+=\S+\s*/g, "").split(/\s+/).filter((p) => p !== "");
      for (const src of parts.slice(0, -1)) {
        if (/^(https?:|\$)/.test(src) || src === "." || src === "./") continue;
        const rel = normJoin("", src.replace(/\/\*.*$/, "").replace(/\/$/, ""));
        if (rel !== null && rel !== "") copies.push(rel);
      }
    } else if (op === "RUN") {
      for (const fm of args.matchAll(/(?:--filter[= ]|-F\s+|--workspace[= ]|-w\s+)["']?([@A-Za-z0-9_./-]+?)["']?(?:\.\.\.)?(?=\s|$|\^)/g)) filters.push((fm[1] ?? "").replace(/^\.\//, ""));
    }
  }
  const runtime = [...stages].reverse().find((s) => !s.startsWith("stage:"));
  return {
    file,
    dir,
    line: firstLine,
    ...(runtime !== undefined ? { base: runtime } : {}),
    stages: stages.filter((s) => !s.startsWith("stage:")),
    expose: uniq(expose),
    ...(workdir !== undefined ? { workdir } : {}),
    ...(cmd !== undefined && cmd !== "" ? { cmd } : {}),
    ...(nameHint !== undefined ? { nameHint: nameHint.toLowerCase() } : {}),
    copies: uniq(copies).slice(0, 40),
    filters: uniq(filters),
  };
}

export function detectDockerfiles(ctx: ScanContext, report: InfraReport): void {
  const files = ctx.fl.files.filter((f) => isDockerfile(f) && !isFixturePath(f));
  if (files.length > MAX_DOCKERFILES) report.truncated = true;
  for (const f of files.slice(0, MAX_DOCKERFILES)) {
    const text = readCached(ctx, f);
    report.filesRead++;
    if (text === null) continue;
    report.dockerfiles.push(parseDockerfile(f, text));
  }
}
