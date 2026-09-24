// CI detector: GitHub Actions (.github/workflows/*.yml) and GitLab CI
// (.gitlab-ci.yml). The glue of "how it ships": which pipeline builds which
// image from which directory, pushes it to which registry and deploys it with
// which tool to which target (a kustomize overlay, a chart, a Terraform root,
// a playbook, a workload, a PaaS).
//
// Steps are read, never run: `run:` / `script:` lines are matched against
// known command shapes (docker build/push, kaniko, kubectl, kustomize, helm,
// terraform/tofu, ansible-playbook, docker compose, fly/vercel/wrangler/…),
// and known actions by their `with:` inputs. `${{ env.X }}` / `$X` resolve
// against literal workflow/job/step env values; anything else becomes a `*`
// wildcard matched against the repo. Secrets are only ever names
// (`${{ secrets.X }}` is left unresolved).
//
// .github is a hidden directory the walker skips, so workflow files are
// listed directly (at most MAX_WORKFLOWS files).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseYaml, yamlGet, yamlKeys, yamlList, yamlString, type YamlValue } from "../mini-yaml.js";
import type { ScanContext } from "../types.js";
import { dirname, readText } from "../walk.js";
import {
  byString,
  imageRegistry,
  imageRepo,
  normJoin,
  readCached,
  uniq,
  type InfraEnd,
  type InfraGroup,
  type InfraItem,
  type InfraLink,
  type InfraReport,
  type Pipeline,
  type PipelineBuild,
  type PipelineDeploy,
} from "./model.js";

const MAX_WORKFLOWS = 200;
const GITLAB_RESERVED = new Set(["stages", "variables", "include", "default", "workflow", "image", "services", "before_script", "after_script", "cache", "pages"]);

interface Step {
  uses?: string;
  with: Record<string, string>;
  run: string;
  cwd: string;
  env: Map<string, string>;
  line: number;
}

interface Job {
  id: string;
  name: string;
  environment?: string;
  steps: Step[];
}

function strRecord(v: YamlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of yamlKeys(v)) {
    const x = yamlGet(v, k);
    if (typeof x === "string") out[k] = x;
    else if (Array.isArray(x)) out[k] = x.filter((y): y is string => typeof y === "string").join("\n");
  }
  return out;
}

function envMap(v: YamlValue | undefined, base: Map<string, string>): Map<string, string> {
  const out = new Map(base);
  for (const [k, val] of Object.entries(strRecord(v))) out.set(k, val);
  return out;
}

/** Substitutes `${{ env.X }}`, `${{ vars.X }}`-less `$X` / `${X}` from literal env; the rest becomes "*". */
function subst(text: string, env: Map<string, string>, depth = 0): string {
  let out = text.replace(/\$\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (m, k: string) => env.get(k) ?? "*");
  out = out.replace(/\$\{\{[^}]*\}\}/g, "*");
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k: string) => env.get(k) ?? (k === "PWD" ? "." : "*"));
  return depth < 2 && /\$\{\{|\$[A-Za-z_{]/.test(out) ? subst(out, env, depth + 1) : out;
}

function lineOfText(lines: readonly string[], needle: string, from = 0): number {
  const n = needle.trim().split("\n")[0]?.trim() ?? "";
  if (n === "") return from + 1;
  const i = lines.findIndex((l, idx) => idx >= from && l.includes(n.slice(0, 60)));
  return (i === -1 ? from : i) + 1;
}

function readGithub(file: string, text: string): { name: string; triggers: string[]; jobs: Job[] } {
  const v = parseYaml(text);
  const lines = text.split(/\r?\n/);
  const on = yamlGet(v, "on") ?? yamlGet(v, "true");
  const triggers: string[] = [];
  if (typeof on === "string") triggers.push(on);
  else if (Array.isArray(on)) triggers.push(...on.filter((x): x is string => typeof x === "string"));
  else
    for (const k of yamlKeys(on)) {
      const branches = [...yamlList(yamlGet(yamlGet(on, k), "branches")), ...yamlList(yamlGet(yamlGet(on, k), "tags"))].filter((x): x is string => typeof x === "string");
      triggers.push(branches.length > 0 ? `${k} ${branches.join(", ")}` : k);
    }
  const wfEnv = envMap(yamlGet(v, "env"), new Map());
  const jobs: Job[] = [];
  const jobsV = yamlGet(v, "jobs");
  let cursor = 0;
  for (const id of yamlKeys(jobsV)) {
    const j = yamlGet(jobsV, id);
    const jobEnv = envMap(yamlGet(j, "env"), wfEnv);
    const defCwd = yamlString(yamlGet(yamlGet(yamlGet(j, "defaults"), "run"), "working-directory")) ?? "";
    const envV = yamlGet(j, "environment");
    const environment = typeof envV === "string" ? envV : yamlString(yamlGet(envV, "name"));
    const steps: Step[] = [];
    const jobLine = lines.findIndex((l, i) => i >= cursor && new RegExp(`^\\s{2,4}${id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}:`).test(l));
    if (jobLine !== -1) cursor = jobLine;
    for (const s of yamlList(yamlGet(j, "steps"))) {
      const uses = yamlString(yamlGet(s, "uses"));
      const run = yamlString(yamlGet(s, "run")) ?? "";
      const withV = strRecord(yamlGet(s, "with"));
      const stepEnv = envMap(yamlGet(s, "env"), jobEnv);
      const cwd = yamlString(yamlGet(s, "working-directory")) ?? defCwd;
      const line = lineOfText(lines, uses ?? run, cursor);
      if (line > cursor) cursor = line - 1;
      steps.push({ ...(uses !== undefined ? { uses } : {}), with: withV, run, cwd: subst(cwd, stepEnv), env: stepEnv, line });
    }
    jobs.push({ id, name: yamlString(yamlGet(j, "name")) ?? id, ...(environment !== undefined ? { environment: subst(environment, jobEnv) } : {}), steps });
  }
  return { name: yamlString(yamlGet(v, "name")) ?? file.slice(file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, ""), triggers, jobs };
}

function readGitlab(text: string): { name: string; triggers: string[]; jobs: Job[] } {
  const v = parseYaml(text);
  const lines = text.split(/\r?\n/);
  const globalEnv = envMap(yamlGet(v, "variables"), new Map());
  const jobs: Job[] = [];
  for (const id of yamlKeys(v)) {
    if (GITLAB_RESERVED.has(id) || id.startsWith(".")) continue;
    const j = yamlGet(v, id);
    const script = [...yamlList(yamlGet(j, "before_script")), ...yamlList(yamlGet(j, "script"))].filter((x): x is string => typeof x === "string");
    if (script.length === 0) continue;
    const env = envMap(yamlGet(j, "variables"), globalEnv);
    const envV = yamlGet(j, "environment");
    const environment = typeof envV === "string" ? envV : yamlString(yamlGet(envV, "name"));
    const line = lines.findIndex((l) => l.startsWith(`${id}:`)) + 1 || 1;
    jobs.push({ id, name: id, ...(environment !== undefined ? { environment } : {}), steps: [{ with: {}, run: script.join("\n"), cwd: "", env, line }] });
  }
  return { name: "GitLab CI", triggers: [], jobs };
}

// ---- command shapes ----

function tokens(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

const OPT_WITH_VALUE = new Set(["-t", "--tag", "-f", "--file", "--build-arg", "--platform", "--target", "--cache-from", "--cache-to", "--secret", "--label", "--progress", "--network", "--output", "-o", "--iidfile", "--ssh", "-n", "--namespace", "--values", "--set", "--set-string", "--version", "--timeout", "--kube-context", "--kubeconfig", "-i", "--inventory", "-e", "--extra-vars", "--limit", "-l", "-u", "--user", "--context", "--repo", "--wait-for-jobs", "--history-max", "-p", "--project-name", "--env-file", "--profile"]);

function positionals(ts: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < ts.length; i++) {
    const t = ts[i] ?? "";
    if (/^[|;&]|^&&$|^\|\|$/.test(t)) break;
    if (t.startsWith("-")) {
      if (!t.includes("=") && OPT_WITH_VALUE.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function optValues(ts: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? "";
    for (const n of names) {
      if (t === n && ts[i + 1] !== undefined) out.push(ts[i + 1] ?? "");
      else if (t.startsWith(`${n}=`)) out.push(t.slice(n.length + 1));
    }
  }
  return out;
}

interface Found {
  builds: Omit<PipelineBuild, "line">[];
  deploys: { tool: string; target: string }[];
  registries: string[];
}

const PLATFORM_COMMANDS: [RegExp, string][] = [
  [/\b(flyctl|fly)\s+deploy\b/, "Fly.io"],
  [/\bvercel(\s+deploy|\s+--prod|\s+--prebuilt)\b/, "Vercel"],
  [/\bnetlify\s+deploy\b/, "Netlify"],
  [/\brailway\s+(up|deploy)\b/, "Railway"],
  [/\bwrangler\s+(deploy|publish|pages\s+deploy)\b/, "Cloudflare Workers"],
  [/\bdoctl\s+apps\s+(create-deployment|update)\b/, "DigitalOcean App Platform"],
  [/\b(serverless|sls)\s+deploy\b/, "Serverless"],
  [/\bsam\s+deploy\b/, "AWS SAM"],
  [/\bcdk\s+deploy\b/, "AWS CDK"],
  [/\bpulumi\s+up\b/, "Pulumi"],
  [/\bheroku\s+(container:release|releases)\b/, "Heroku"],
  [/\bfirebase\s+deploy\b/, "Firebase"],
];

const ACTION_PLATFORMS: [RegExp, string][] = [
  [/^superfly\/flyctl-actions/, "Fly.io"],
  [/^amondnet\/vercel-action/, "Vercel"],
  [/^cloudflare\/(wrangler-action|pages-action)/, "Cloudflare Workers"],
  [/^digitalocean\/app_action/, "DigitalOcean App Platform"],
  [/^azure\/webapps-deploy/, "Azure App Service"],
  [/^azure\/functions-action/, "Azure Functions"],
  [/^FirebaseExtended\/action-hosting-deploy/, "Firebase"],
  [/^netlify\/actions/, "Netlify"],
  [/^railwayapp\//, "Railway"],
];

function scanCommands(text: string, cwd: string): Found {
  const f: Found = { builds: [], deploys: [], registries: [] };
  const joined = text.replace(/\\\r?\n\s*/g, " ");
  const rel = (p: string): string => {
    const clean = p.replace(/^\.\//, "");
    if (p.startsWith("/") || p.includes("://")) return p;
    return normJoin(cwd.replace(/^\.\/?/, ""), clean) ?? clean;
  };
  for (const raw of joined.split(/\r?\n|&&|;(?=\s)/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const ts = tokens(line);
    const at = (re: RegExp): number => ts.findIndex((t) => re.test(t));
    // docker build / buildx build / podman build
    const b = ts.findIndex((t, i) => t === "build" && /^(docker|podman|buildx|buildah)$/.test(ts[i - 1] ?? ""));
    if (b !== -1 && !/compose/.test(ts[b - 2] ?? "") && ts[b - 1] !== "compose") {
      const tags = optValues(ts, ["-t", "--tag"]);
      const file = optValues(ts, ["-f", "--file"])[0];
      const pos = positionals(ts, b + 1);
      const context = pos[pos.length - 1];
      const build: Omit<PipelineBuild, "line"> = {
        ...(tags[0] !== undefined ? { image: imageRepo(tags[0]) } : {}),
        ...(context !== undefined ? { context: rel(context) } : {}),
        ...(file !== undefined ? { dockerfile: rel(file) } : {}),
      };
      f.builds.push(build);
      for (const t of tags.slice(1)) f.builds.push({ ...build, image: imageRepo(t) });
    }
    const push = ts.findIndex((t, i) => t === "push" && /^(docker|podman)$/.test(ts[i - 1] ?? ""));
    if (push !== -1 && ts[push + 1] !== undefined) f.registries.push(...[imageRegistry(ts[push + 1] ?? "")].filter((r): r is string => r !== undefined));
    const login = ts.findIndex((t, i) => t === "login" && /^(docker|podman)$/.test(ts[i - 1] ?? ""));
    if (login !== -1) {
      const reg = positionals(ts, login + 1)[0];
      if (reg !== undefined && reg.includes(".")) f.registries.push(reg);
    }
    if (/\/kaniko\/executor|\bexecutor\b.*--destination/.test(line)) {
      const dest = optValues(ts, ["--destination", "-d"])[0];
      const context = optValues(ts, ["--context", "-c"])[0];
      const file = optValues(ts, ["--dockerfile", "-f"])[0];
      f.builds.push({
        ...(dest !== undefined ? { image: imageRepo(dest) } : {}),
        ...(context !== undefined ? { context: rel(context.replace(/^dir:\/\//, "").replace(/^\$CI_PROJECT_DIR\/?/, "")) } : {}),
        ...(file !== undefined ? { dockerfile: rel(file.replace(/^\$CI_PROJECT_DIR\/?/, "")) } : {}),
      });
    }
    if (/\bgcloud\s+builds\s+submit\b/.test(line)) {
      const tag = optValues(ts, ["--tag"])[0];
      const pos = positionals(ts, at(/^submit$/) + 1);
      f.builds.push({ ...(tag !== undefined ? { image: imageRepo(tag) } : {}), ...(pos[0] !== undefined ? { context: rel(pos[0]) } : {}) });
    }
    // Kubernetes
    const kubectl = at(/^(kubectl|oc|k)$/);
    if (kubectl !== -1) {
      const sub = ts[kubectl + 1] ?? "";
      if (sub === "apply" || sub === "create" || sub === "replace") {
        for (const k of optValues(ts, ["-k", "--kustomize"])) f.deploys.push({ tool: "kustomize", target: rel(k) });
        for (const p of optValues(ts, ["-f", "--filename"])) if (p !== "-") f.deploys.push({ tool: "kubectl", target: rel(p) });
      } else if (sub === "set" && ts[kubectl + 2] === "image") {
        const w = ts.slice(kubectl + 3).find((t) => /^(deployment|deploy|statefulset|sts|daemonset|ds|cronjob)(\.apps)?\//.test(t));
        if (w !== undefined) f.deploys.push({ tool: "kubectl", target: `workload:${w.slice(w.indexOf("/") + 1)}` });
      } else if (sub === "rollout" && ts[kubectl + 2] === "restart") {
        const w = ts.slice(kubectl + 3).find((t) => /\//.test(t));
        if (w !== undefined) f.deploys.push({ tool: "kubectl", target: `workload:${w.slice(w.indexOf("/") + 1)}` });
      }
    }
    const kz = ts.findIndex((t, i) => t === "build" && ts[i - 1] === "kustomize");
    if (kz !== -1) {
      const dir = positionals(ts, kz + 1)[0];
      if (dir !== undefined && /\bkubectl\b.*\bapply\b|\|\s*kubectl/.test(line)) f.deploys.push({ tool: "kustomize", target: rel(dir) });
    }
    const helm = at(/^helm$/);
    if (helm !== -1 && /^(upgrade|install)$/.test(ts[helm + 1] ?? "")) {
      const pos = positionals(ts, helm + 2);
      const chart = pos[1] ?? pos[0];
      if (chart !== undefined) f.deploys.push({ tool: "helm", target: chart.startsWith("oci://") || !chart.includes("/") && !chart.startsWith(".") ? chart : rel(chart) });
    }
    if (/\bhelmfile\b.*\b(apply|sync|deploy)\b/.test(line)) f.deploys.push({ tool: "helmfile", target: optValues(ts, ["-f", "--file"])[0] ?? "helmfile.yaml" });
    const tf = at(/^(terraform|tofu|terragrunt)$/);
    if (tf !== -1 && ts.slice(tf + 1).some((t) => t === "apply" || t === "run-all")) {
      const chdir = optValues(ts, ["-chdir"])[0];
      f.deploys.push({ tool: ts[tf] === "tofu" ? "opentofu" : "terraform", target: chdir !== undefined ? rel(chdir) : rel(".") });
    }
    const ap = at(/^ansible-playbook$/);
    if (ap !== -1) {
      const pb = positionals(ts, ap + 1).find((p) => /\.ya?ml$/.test(p));
      if (pb !== undefined) f.deploys.push({ tool: "ansible", target: rel(pb) });
    }
    if (/\bdocker[- ]compose\b.*\bup\b|\bdocker\s+stack\s+deploy\b/.test(line)) {
      f.deploys.push({ tool: "compose", target: optValues(ts, ["-f", "--file", "-c", "--compose-file"]).map(rel)[0] ?? "compose" });
    }
    if (/\bdocker[- ]compose\b.*\bbuild\b/.test(line)) f.builds.push({ context: "compose" });
    const gr = /\bgcloud\s+run\s+deploy\s+([A-Za-z0-9*_-]+)/.exec(line);
    if (gr !== null) f.deploys.push({ tool: "cloud-run", target: `name:${gr[1] ?? ""}` });
    if (/\baws\s+ecs\s+update-service\b/.test(line)) {
      const svc = optValues(ts, ["--service"])[0];
      if (svc !== undefined) f.deploys.push({ tool: "ecs", target: `name:${svc}` });
    }
    for (const [re, name] of PLATFORM_COMMANDS) if (re.test(line)) f.deploys.push({ tool: "platform", target: name });
  }
  return f;
}

function scanAction(step: Step): Found {
  const f: Found = { builds: [], deploys: [], registries: [] };
  const uses = step.uses ?? "";
  const w = (k: string): string | undefined => (step.with[k] !== undefined ? subst(step.with[k] ?? "", step.env) : undefined);
  const rel = (p: string): string => normJoin(step.cwd.replace(/^\.\/?/, ""), p.replace(/^\.\//, "")) ?? p;
  if (/^docker\/build-push-action/.test(uses)) {
    const tags = (w("tags") ?? "").split(/[\n,]/).map((t) => t.trim()).filter((t) => t !== "");
    const context = w("context");
    const file = w("file");
    const base: Omit<PipelineBuild, "line"> = { context: rel(context ?? "."), ...(file !== undefined ? { dockerfile: rel(file) } : {}) };
    if (tags.length === 0) f.builds.push(base);
    for (const t of tags) f.builds.push({ ...base, image: imageRepo(t) });
  } else if (/^docker\/login-action/.test(uses)) {
    const reg = w("registry");
    f.registries.push(reg !== undefined && reg !== "*" ? reg : "docker.io");
  } else if (/^aws-actions\/amazon-ecr-login/.test(uses)) {
    f.registries.push("ECR");
  } else if (/^azure\/k8s-deploy/.test(uses)) {
    for (const m of (w("manifests") ?? "").split(/\n/).map((x) => x.trim()).filter((x) => x !== "")) f.deploys.push({ tool: "kubectl", target: rel(m) });
  } else if (/^google-github-actions\/deploy-cloudrun/.test(uses)) {
    f.deploys.push({ tool: "cloud-run", target: `name:${w("service") ?? "*"}` });
  } else if (/^aws-actions\/amazon-ecs-deploy-task-definition/.test(uses)) {
    f.deploys.push({ tool: "ecs", target: `name:${w("service") ?? "*"}` });
  } else if (/^dawidd6\/action-ansible-playbook/.test(uses)) {
    const pb = w("playbook");
    if (pb !== undefined) f.deploys.push({ tool: "ansible", target: rel(joinDir(w("directory") ?? "", pb)) });
  } else if (/^appleboy\/ssh-action/.test(uses)) {
    const inner = scanCommands(w("script") ?? "", "");
    f.builds.push(...inner.builds);
    f.deploys.push(...inner.deploys);
    f.registries.push(...inner.registries);
  } else if (/^helmfile\//.test(uses)) {
    f.deploys.push({ tool: "helmfile", target: "helmfile.yaml" });
  }
  for (const [re, name] of ACTION_PLATFORMS) if (re.test(uses)) f.deploys.push({ tool: "platform", target: name });
  return f;
}

function joinDir(dir: string, p: string): string {
  return dir === "" ? p : `${dir.replace(/\/$/, "")}/${p}`;
}

// ---- detector ----

export function detectCi(ctx: ScanContext, report: InfraReport): void {
  const files: { file: string; provider: "github" | "gitlab"; text: string }[] = [];
  const wfDir = path.join(ctx.root, ".github", "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    names = [];
  }
  if (names.length > MAX_WORKFLOWS) report.truncated = true;
  for (const n of names.slice(0, MAX_WORKFLOWS)) {
    const rel = `.github/workflows/${n}`;
    const text = readText(ctx.root, rel);
    report.filesRead++;
    if (text !== null) files.push({ file: rel, provider: "github", text });
  }
  if (ctx.fl.fileSet.has(".gitlab-ci.yml")) {
    const text = readCached(ctx, ".gitlab-ci.yml");
    report.filesRead++;
    if (text !== null) files.push({ file: ".gitlab-ci.yml", provider: "gitlab", text });
  }
  if (files.length === 0) return;

  const groups = new Map<string, InfraGroup>();
  const groupFor = (provider: "github" | "gitlab"): InfraGroup => {
    const key = `ci:${provider}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        tool: "ci",
        name: provider === "github" ? "CI/CD: GitHub Actions" : "CI/CD: GitLab CI",
        kind: "pipelines",
        ...(provider === "github" ? { path: ".github/workflows" } : {}),
        files: [],
        settings: {},
        details: [],
        hints: [],
      };
      groups.set(key, g);
    }
    return g;
  };
  const items: InfraItem[] = [];
  const registryItems = new Map<string, InfraItem>();
  const platformItems = new Map<string, InfraItem>();
  for (const { file, provider, text } of files) {
    const wf = provider === "github" ? readGithub(file, text) : readGitlab(text);
    const g = groupFor(provider);
    g.files.push(file);
    const builds: PipelineBuild[] = [];
    const deploys: PipelineDeploy[] = [];
    const registries: string[] = [];
    const environments: string[] = [];
    for (const job of wf.jobs) {
      if (job.environment !== undefined && job.environment !== "*") environments.push(job.environment);
      // docker/metadata-action images stand in for `${{ steps.meta.outputs.tags }}`.
      const metaImages = job.steps.filter((s) => /^docker\/metadata-action/.test(s.uses ?? "")).flatMap((s) => subst(s.with.images ?? "", s.env).split(/[\n,]/).map((x) => x.trim()).filter((x) => x !== "" && !x.includes("=")));
      for (const s of job.steps) {
        const found = s.uses !== undefined ? scanAction(s) : scanCommands(subst(s.run, s.env), s.cwd);
        for (const b of found.builds) {
          if ((b.image === undefined || b.image === "*") && metaImages[0] !== undefined) {
            for (const img of metaImages) builds.push({ ...b, image: imageRepo(img), line: s.line });
          } else builds.push({ ...b, line: s.line });
        }
        for (const d of found.deploys) deploys.push({ ...d, line: s.line, targets: [] });
        registries.push(...found.registries);
      }
    }
    for (const b of builds) {
      const reg = b.image !== undefined ? imageRegistry(b.image) : undefined;
      if (reg !== undefined && reg !== "*") registries.push(reg);
    }
    if (builds.length === 0 && deploys.length === 0) {
      g.details.push(`${file.slice(file.lastIndexOf("/") + 1)} (${wf.name}: ${wf.jobs.length} job${wf.jobs.length === 1 ? "" : "s"}, no build or deploy)`);
      continue;
    }
    const slugName = file.slice(file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, "");
    const key = `ci:${provider}:${slugName}`;
    const uniqBuilds = uniqBy(builds, (b) => `${b.image ?? ""}\u0000${b.context ?? ""}\u0000${b.dockerfile ?? ""}`);
    const uniqDeploys = uniqBy(deploys, (d) => `${d.tool}\u0000${d.target}`);
    const item: InfraItem = {
      key,
      group: g.key,
      tool: "ci",
      kind: provider === "github" ? "workflow" : "pipeline",
      address: file,
      name: provider === "github" ? wf.name : "GitLab CI",
      category: "pipeline",
      file,
      line: 1,
      settings: {
        ...(wf.triggers.length > 0 ? { triggers: wf.triggers.join("; ") } : {}),
        jobs: String(wf.jobs.length),
        ...(uniqBuilds.length > 0 ? { builds: uniq(uniqBuilds.map((b) => b.image ?? b.context ?? "image")).join(", ") } : {}),
        ...(uniqDeploys.length > 0 ? { deploys: uniqDeploys.map((d) => `${d.tool} ${d.target}`).slice(0, 8).join(", ") } : {}),
        ...(uniq(environments).length > 0 ? { environments: uniq(environments).join(", ") } : {}),
      },
      details: [],
      hints: [slugName, wf.name],
      images: uniq(uniqBuilds.map((b) => b.image).filter((i): i is string => i !== undefined && i !== "*")),
      tech: [provider === "github" ? "GitHub Actions" : "GitLab CI"],
    };
    items.push(item);
    const pipeline: Pipeline = {
      itemKey: key,
      provider,
      file,
      name: item.name,
      triggers: wf.triggers,
      builds: uniqBuilds,
      deploys: uniqDeploys,
      registries: uniq(registries.filter((r) => r !== "*")).sort(),
      environments: uniq(environments),
    };
    report.pipelines.push(pipeline);
    for (const reg of pipeline.registries) {
      const images = item.images.filter((i) => i.startsWith(`${reg}/`) || (reg === "docker.io" && imageRegistry(i) === undefined));
      const ns = uniq(images.map((i) => i.split("/").slice(0, -1).join("/")).filter((x) => x !== "" && !x.includes("*")));
      const regName = ns.length === 1 ? (ns[0] ?? reg) : reg;
      const rkey = `ci:registry:${regName}`;
      if (!registryItems.has(rkey)) {
        registryItems.set(rkey, {
          key: rkey,
          group: g.key,
          tool: "ci",
          kind: "registry",
          address: regName,
          name: regName,
          category: "registry",
          file,
          line: 1,
          settings: { registry: reg },
          details: [],
          hints: [regName, reg],
          images: [],
          tech: ["Container registry"],
        });
      }
      report.links.push({ from: { item: key }, to: { item: rkey }, label: "pushes", kind: "deploy", evidence: [`${file}:${pipeline.builds[0]?.line ?? 1}`] });
    }
    for (const d of pipeline.deploys) {
      if (d.tool !== "platform") continue;
      const pkey = `ci:platform:${d.target}`;
      if (!platformItems.has(pkey)) {
        platformItems.set(pkey, { key: pkey, group: g.key, tool: "ci", kind: "platform", address: d.target, name: d.target, category: "platform", file, line: d.line, settings: {}, details: [], hints: [d.target], images: [], tech: [d.target] });
      }
      d.targets.push({ item: pkey });
    }
  }
  for (const g of groups.values()) {
    g.files.sort(byString);
    g.details.sort(byString);
  }
  report.groups.push(...[...groups.values()].sort((a, b) => byString(a.key, b.key)));
  report.items.push(...items, ...registryItems.values(), ...platformItems.values());
}

function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `*` wildcards in CI paths (`deploy/k8s/overlays/*`) as a matcher. */
function pathMatcher(p: string): (x: string) => boolean {
  if (!p.includes("*")) return (x) => x === p;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return (x) => re.test(x);
}

/**
 * Resolves what each pipeline deploys to against the other detectors'
 * groups and items, and emits the pipeline's links: builds (code / image),
 * deploys (targets).
 */
export function resolvePipelines(report: InfraReport): void {
  for (const p of report.pipelines) {
    for (const d of p.deploys) {
      const t: InfraEnd[] = [...d.targets];
      const match = pathMatcher(d.target);
      const under = (file: string): boolean => match(file) || [...Array(file.split("/").length).keys()].some((i) => match(file.split("/").slice(0, i).join("/")));
      if (d.tool === "kustomize" || d.tool === "kubectl") {
        if (d.target.startsWith("workload:")) {
          const name = d.target.slice(9);
          const m = pathMatcher(name);
          for (const it of report.items) if ((it.category === "workload" || it.category === "job") && (it.tool === "kubernetes" || it.tool === "kustomize" || it.tool === "helm") && m(it.name)) t.push({ item: it.key });
        } else {
          const groups = report.groups.filter((g) => g.tool === "kubernetes" && (g.settings.overlays ?? "").split(", ").some((o) => o !== "" && (match(o) || o.startsWith(`${d.target}/`))));
          for (const g of groups) t.push({ group: g.key });
          if (groups.length === 0) {
            const hits = report.items.filter((it) => (it.tool === "kubernetes" || it.tool === "kustomize") && under(it.file));
            const gs = uniq(hits.map((h) => h.group));
            if (hits.length > 6) for (const g of gs) t.push({ group: g });
            else for (const h of hits) t.push({ item: h.key });
          }
        }
      } else if (d.tool === "helm") {
        const last = d.target.slice(d.target.lastIndexOf("/") + 1);
        const byPath = report.groups.filter((x) => x.tool === "helm" && x.path !== undefined && match(x.path));
        const gs = byPath.length > 0 ? byPath : report.groups.filter((x) => x.tool === "helm" && x.settings.chart === last);
        for (const g of gs) t.push({ group: g.key });
      } else if (d.tool === "terraform" || d.tool === "opentofu") {
        const rootOf = (g: InfraGroup): string => (g.settings.root === "." ? "" : (g.settings.root ?? ""));
        const tfGroups = report.groups.filter((g) => g.tool === "terraform");
        let gs = tfGroups.filter((g) => match(rootOf(g)));
        // `terraform apply` in a parent directory of the root(s).
        if (gs.length === 0) gs = tfGroups.filter((g) => d.target === "" || rootOf(g).startsWith(`${d.target}/`));
        for (const g of gs) t.push({ group: g.key });
      } else if (d.tool === "ansible") {
        const base = d.target.slice(d.target.lastIndexOf("/") + 1);
        const hits = report.items.filter((it) => it.tool === "ansible" && it.kind === "hosts" && (it.file === d.target || match(it.file) || (it.settings.playbooks ?? "").split(", ").includes(base)));
        for (const h of hits) t.push({ item: h.key });
        if (hits.length === 0) for (const g of report.groups.filter((x) => x.tool === "ansible")) t.push({ group: g.key });
      } else if (d.tool === "compose") {
        t.push({ codeName: "compose" });
      } else if (d.tool === "cloud-run" || d.tool === "ecs") {
        const name = d.target.slice(5);
        const m = pathMatcher(name);
        const hits = report.items.filter((it) => it.tool === "terraform" && it.hints.some((h) => m(h)) && (it.category === "compute" || it.category === "workload"));
        for (const h of hits) t.push({ item: h.key });
      }
      d.targets = uniqBy(t, (e) => JSON.stringify(e));
      for (const e of d.targets) {
        report.links.push({ from: { item: p.itemKey }, to: e, label: "deploys", kind: "deploy", evidence: [`${p.file}:${d.line}`] });
      }
    }
    for (const b of p.builds) {
      const to: InfraEnd | undefined =
        b.dockerfile !== undefined
          ? { dockerfile: b.dockerfile }
          : b.context !== undefined && b.context !== "compose"
            ? { codeDir: b.context === "." ? "" : b.context }
            : b.image !== undefined && b.image !== "*"
              ? { image: b.image }
              : undefined;
      if (to !== undefined) report.links.push({ from: { item: p.itemKey }, to, label: "builds", kind: "deploy", evidence: [`${p.file}:${b.line}`] });
      if (b.image !== undefined && b.image !== "*" && to !== undefined && !("image" in to)) {
        report.links.push({ from: { item: p.itemKey }, to: { image: b.image }, label: "builds", kind: "deploy", evidence: [`${p.file}:${b.line}`] });
      }
    }
  }
}
