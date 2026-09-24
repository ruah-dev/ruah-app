// Ansible detector: playbooks, roles, inventories.
//
// A playbook is a YAML list of plays with `hosts:`. Each host pattern a play
// targets becomes an item (category "server"), with the roles applied to it
// as details and the inventory's hosts (names only — inventory variables,
// group_vars and host_vars are never read: they hold credentials). Roles are
// read for what they deploy: docker containers (image → code), packages and
// role names that are well-known products (nginx, postgres, redis, …) become
// items on that host group; template names that match a code package link
// the host group to it ("configures").
import { INFRA_KINDS, type InfraKind } from "../detectors/compose.js";
import { parseYaml, yamlGet, yamlKeys, yamlList, yamlString, type YamlValue } from "../mini-yaml.js";
import type { ScanContext } from "../types.js";
import { dirname, joinRel } from "../walk.js";
import { byString, isFixturePath, readCached, uniq, type InfraCategory, type InfraGroup, type InfraItem, type InfraLink, type InfraReport } from "./model.js";

const MAX_PLAYBOOKS = 200;
const MAX_ROLE_FILES = 20;

const PRODUCT_ALIASES: Record<string, string> = {
  postgresql: "postgres", pgsql: "postgres", "postgresql-server": "postgres", mariadb: "mysql", "mysql-server": "mysql",
  "redis-server": "redis", mongodb: "mongo", "mongodb-org": "mongo", "nginx-full": "nginx", "rabbitmq-server": "rabbitmq",
};

function productKind(name: string): InfraKind | undefined {
  const n = name.toLowerCase().replace(/^(ansible-role-|role-)/, "").replace(/[._]/g, "-");
  const key = PRODUCT_ALIASES[n] ?? n;
  return INFRA_KINDS.find((k) => k.key === key || k.images.includes(key));
}

function categoryOf(k: InfraKind): InfraCategory {
  return k.type === "datastore" ? "database" : k.key === "redis" ? "cache" : k.type === "queue" ? "queue" : k.type === "gateway" ? "gateway" : "compute";
}

interface Play {
  file: string;
  line: number;
  name?: string;
  hosts: string[];
  roles: string[];
  become: boolean;
  tasks: YamlValue[];
}

function isPlaybook(v: YamlValue): boolean {
  return Array.isArray(v) && v.length > 0 && v.some((p) => yamlGet(p, "hosts") !== undefined || yamlGet(p, "import_playbook") !== undefined);
}

function roleName(r: YamlValue): string | undefined {
  if (typeof r === "string") return r;
  return yamlString(yamlGet(r, "role")) ?? yamlString(yamlGet(r, "name"));
}

// Modules in a task list: images, packages, templates, included roles.
interface TaskFacts {
  images: string[];
  packages: string[];
  templates: string[];
  roles: string[];
  compose: string[];
}

function taskFacts(tasks: YamlValue[], depth = 0): TaskFacts {
  const f: TaskFacts = { images: [], packages: [], templates: [], roles: [], compose: [] };
  if (depth > 3) return f;
  for (const t of tasks) {
    for (const k of yamlKeys(t)) {
      const mod = k.replace(/^(ansible\.builtin|community\.docker|community\.general|ansible\.posix|containers\.podman)\./, "");
      const v = yamlGet(t, k);
      if (mod === "docker_container" || mod === "podman_container" || mod === "docker_image") {
        const img = yamlString(yamlGet(v, "image")) ?? (mod === "docker_image" ? yamlString(yamlGet(v, "name")) : undefined);
        if (img !== undefined && !img.includes("{{")) f.images.push(img);
      } else if (mod === "apt" || mod === "yum" || mod === "dnf" || mod === "package") {
        const name = yamlGet(v, "name") ?? yamlGet(v, "pkg");
        f.packages.push(...(typeof name === "string" ? name.split(/[,\s]+/) : yamlList(name).map((x) => yamlString(x) ?? "")).filter((x) => x !== "" && !x.includes("{{")));
      } else if (mod === "template") {
        const src = yamlString(yamlGet(v, "src")) ?? (typeof v === "string" ? /src=(\S+)/.exec(v)?.[1] : undefined);
        if (src !== undefined) f.templates.push(src.replace(/^.*\//, ""));
      } else if (mod === "include_role" || mod === "import_role") {
        const n = yamlString(yamlGet(v, "name"));
        if (n !== undefined) f.roles.push(n);
      } else if (mod === "docker_compose" || mod === "docker_compose_v2") {
        const src = yamlString(yamlGet(v, "project_src"));
        if (src !== undefined) f.compose.push(src);
      } else if (mod === "block" || mod === "rescue" || mod === "always") {
        const inner = taskFacts(yamlList(v), depth + 1);
        f.images.push(...inner.images);
        f.packages.push(...inner.packages);
        f.templates.push(...inner.templates);
        f.roles.push(...inner.roles);
        f.compose.push(...inner.compose);
      }
    }
  }
  return f;
}

function parseIniInventory(text: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current = "ungrouped";
  let mode: "hosts" | "children" | "vars" = "hosts";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (line === "") continue;
    const sec = /^\[([^\]:]+)(?::(children|vars))?\]$/.exec(line);
    if (sec !== null) {
      current = sec[1] ?? "ungrouped";
      mode = sec[2] === "children" ? "children" : sec[2] === "vars" ? "vars" : "hosts";
      if (!groups.has(current)) groups.set(current, []);
      continue;
    }
    if (mode === "vars") continue;
    const token = line.split(/\s+/)[0] ?? "";
    if (token === "" || token.includes("=")) continue;
    groups.set(current, [...(groups.get(current) ?? []), mode === "children" ? `@${token}` : token]);
  }
  return groups;
}

function parseYamlInventory(v: YamlValue): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const visit = (name: string, g: YamlValue | undefined, depth: number): void => {
    if (depth > 8) return;
    const hosts = yamlKeys(yamlGet(g, "hosts"));
    const children = yamlKeys(yamlGet(g, "children"));
    groups.set(name, [...(groups.get(name) ?? []), ...hosts, ...children.map((c) => `@${c}`)]);
    for (const c of children) visit(c, yamlGet(yamlGet(g, "children"), c), depth + 1);
  };
  for (const top of yamlKeys(v)) visit(top, yamlGet(v, top), 0);
  return groups;
}

function hostsOf(group: string, inv: Map<string, string[]>, depth = 0): string[] {
  if (depth > 8) return [];
  const members = inv.get(group) ?? [];
  const out: string[] = [];
  for (const m of members) out.push(...(m.startsWith("@") ? hostsOf(m.slice(1), inv, depth + 1) : [m]));
  if (group === "all" && out.length === 0) for (const [, ms] of inv) out.push(...ms.filter((m) => !m.startsWith("@")));
  return uniq(out);
}

export function detectAnsible(ctx: ScanContext, report: InfraReport): void {
  const yamls = ctx.fl.files.filter(
    (f) => /\.ya?ml$/.test(f) && !isFixturePath(f) && !/(^|\/)(roles|group_vars|host_vars|vars|defaults|handlers|meta|molecule|templates)\//.test(f) && !/(^|\/)(Chart|values[^/]*|kustomization|docker-compose[^/]*|compose[^/]*)\.ya?ml$/.test(f),
  );
  const plays: Play[] = [];
  let checked = 0;
  for (const f of yamls) {
    if (checked >= MAX_PLAYBOOKS * 10) {
      report.truncated = true;
      break;
    }
    const text = readCached(ctx, f);
    checked++;
    if (text === null || !/^\s*-\s+(name:|hosts:|import_playbook:)/m.test(text) || !/^\s*-?\s*hosts:/m.test(text)) continue;
    const v = parseYaml(text);
    if (!isPlaybook(v)) continue;
    const lines = text.split(/\r?\n/);
    let from = 0;
    for (const p of yamlList(v)) {
      const hosts = yamlString(yamlGet(p, "hosts"));
      if (hosts === undefined) continue;
      const idx = lines.findIndex((l, i) => i >= from && /^\s*-?\s*hosts:/.test(l));
      from = idx + 1;
      const name = yamlString(yamlGet(p, "name"));
      plays.push({
        file: f,
        line: idx + 1 || 1,
        ...(name !== undefined ? { name } : {}),
        hosts: hosts.split(/[:,]/).map((h) => h.trim().replace(/^[!&]/, "")).filter((h) => h !== "" && !h.includes("{{")),
        roles: yamlList(yamlGet(p, "roles")).map(roleName).filter((r): r is string => r !== undefined),
        become: yamlString(yamlGet(p, "become")) === "true" || yamlString(yamlGet(p, "become")) === "yes",
        tasks: [...yamlList(yamlGet(p, "tasks")), ...yamlList(yamlGet(p, "pre_tasks")), ...yamlList(yamlGet(p, "post_tasks"))],
      });
    }
  }
  report.filesRead += checked;
  if (plays.length === 0) return;

  // Ansible projects: the directory holding ansible.cfg, else the playbook's directory (roles/ next to it).
  const cfgDirs = ctx.fl.files.filter((f) => /(^|\/)ansible\.cfg$/.test(f)).map(dirname);
  const projectOf = (file: string): string => {
    const d = dirname(file);
    const cfg = cfgDirs.filter((c) => c === "" || d === c || d.startsWith(`${c}/`)).sort((a, b) => b.length - a.length)[0];
    if (cfg !== undefined) return cfg;
    return /(^|\/)playbooks$/.test(d) ? dirname(d) : d;
  };
  const projects = uniq(plays.map((p) => projectOf(p.file))).sort();
  for (const proj of projects) {
    const projPlays = plays.filter((p) => projectOf(p.file) === proj);
    // Inventories (names only).
    const invFiles = ctx.fl.files.filter((f) => {
      if (!(proj === "" || f.startsWith(`${proj}/`))) return false;
      const rel = proj === "" ? f : f.slice(proj.length + 1);
      return /^(inventory|inventories|hosts)(\.(ini|ya?ml|cfg))?$/.test(rel) || /^inventor(y|ies)\/.*(hosts|inventory)?[^/]*(\.(ini|ya?ml))?$/.test(rel) && !/(group_vars|host_vars)\//.test(rel);
    });
    const inv = new Map<string, string[]>();
    for (const f of invFiles.slice(0, 20)) {
      const text = readCached(ctx, f);
      report.filesRead++;
      if (text === null) continue;
      const parsed = /\.ya?ml$/.test(f) ? parseYamlInventory(parseYaml(text)) : parseIniInventory(text);
      for (const [g, hs] of parsed) inv.set(g, uniq([...(inv.get(g) ?? []), ...hs]));
    }
    const group: InfraGroup = {
      key: `ansible:${proj}`,
      tool: "ansible",
      name: projects.length > 1 ? `Ansible: ${proj === "" ? "root" : proj}` : "Ansible",
      kind: "inventory",
      ...(proj !== "" ? { path: proj } : {}),
      files: uniq([...projPlays.map((p) => p.file), ...invFiles.slice(0, 20)]).sort(),
      settings: {
        playbooks: uniq(projPlays.map((p) => p.file.slice(p.file.lastIndexOf("/") + 1))).join(", "),
        ...(invFiles.length > 0 ? { inventories: invFiles.slice(0, 5).join(", ") } : {}),
      },
      details: [],
      hints: [],
    };
    const roleDir = (name: string): string | undefined => {
      const candidates = [joinRel(proj, `roles/${name}`), joinRel(dirname(projPlays[0]?.file ?? ""), `roles/${name}`)];
      return candidates.find((d) => ctx.fl.dirs.has(d)) ?? [...ctx.fl.dirs].find((d) => d.endsWith(`/roles/${name}`) || d === `roles/${name}`);
    };
    const roleFacts = new Map<string, TaskFacts & { templatesDir: string[]; file?: string }>();
    const factsOfRole = (name: string, depth = 0): TaskFacts & { templatesDir: string[]; file?: string } => {
      const cached = roleFacts.get(name);
      if (cached !== undefined) return cached;
      const out: TaskFacts & { templatesDir: string[]; file?: string } = { images: [], packages: [], templates: [], roles: [], compose: [], templatesDir: [] };
      roleFacts.set(name, out);
      const dir = roleDir(name);
      if (dir === undefined) return out;
      const taskFiles = ctx.fl.files.filter((f) => f.startsWith(`${dir}/tasks/`) && /\.ya?ml$/.test(f)).slice(0, MAX_ROLE_FILES);
      for (const f of taskFiles) {
        const text = readCached(ctx, f);
        report.filesRead++;
        if (text === null) continue;
        out.file ??= f;
        const tf = taskFacts(yamlList(parseYaml(text)));
        out.images.push(...tf.images);
        out.packages.push(...tf.packages);
        out.templates.push(...tf.templates);
        out.roles.push(...tf.roles);
        out.compose.push(...tf.compose);
      }
      out.templatesDir = ctx.fl.files.filter((f) => f.startsWith(`${dir}/templates/`)).map((f) => f.slice(f.lastIndexOf("/") + 1)).slice(0, 20);
      if (depth < 3) for (const r of out.roles) {
        const inner = factsOfRole(r, depth + 1);
        out.images.push(...inner.images);
        out.packages.push(...inner.packages);
      }
      return out;
    };

    const items = new Map<string, InfraItem>();
    const links: InfraLink[] = [];
    for (const play of projPlays) {
      const pf = taskFacts(play.tasks);
      const roles = uniq([...play.roles, ...pf.roles]);
      for (const pattern of play.hosts) {
        const key = `ansible:${proj}:hosts/${pattern}`;
        let item = items.get(key);
        const hosts = hostsOf(pattern, inv);
        if (item === undefined) {
          item = {
            key,
            group: group.key,
            tool: "ansible",
            kind: "hosts",
            address: pattern,
            name: pattern,
            category: "server",
            file: play.file,
            line: play.line,
            settings: {},
            details: [],
            hints: uniq([pattern, ...hosts.slice(0, 20)]),
            images: [],
            tech: ["Ansible"],
          };
          items.set(key, item);
        }
        if (hosts.length > 0) item.settings.hosts = `${hosts.length}: ${hosts.slice(0, 5).join(", ")}${hosts.length > 5 ? ", …" : ""}`;
        item.settings.playbooks = uniq([...(item.settings.playbooks?.split(", ") ?? []), play.file.slice(play.file.lastIndexOf("/") + 1)]).join(", ");
        if (play.become) item.settings.become = "true";
        if (roles.length > 0) item.settings.roles = uniq([...(item.settings.roles?.split(", ") ?? []), ...roles]).join(", ");
        item.details.push(...roles.map((r) => `role ${r}`), ...(play.name !== undefined ? [`play "${play.name}"`] : []));
        const evidence = [`${play.file}:${play.line}`];
        const facts = [pf, ...roles.map((r) => factsOfRole(r))];
        const images = uniq(facts.flatMap((f) => f.images));
        item.images = uniq([...item.images, ...images]);
        for (const img of images) links.push({ from: { item: key }, to: { image: img }, label: "runs", kind: "deploy", evidence });
        const templates = uniq(facts.flatMap((f) => [...f.templates, ...("templatesDir" in f ? (f as { templatesDir: string[] }).templatesDir : [])]));
        if (templates.length > 0) item.details.push(...templates.slice(0, 10).map((t) => `template ${t}`));
        for (const t of templates) {
          const base = t.replace(/\.j2$/, "").replace(/\.(conf|env|ya?ml|service|ini|json|toml)$/, "").replace(/[._-](config|env|service)$/, "");
          if (base !== "") links.push({ from: { item: key }, to: { codeName: base }, label: "configures", kind: "deploy", evidence });
        }
        for (const r of roles) links.push({ from: { item: key }, to: { codeName: r }, label: "deploys", kind: "deploy", evidence });
        // Products the host group runs: roles and packages named after them.
        const products = new Map<string, { kind: InfraKind; via: string }>();
        for (const r of roles) {
          const k = productKind(r);
          if (k !== undefined) products.set(k.key, { kind: k, via: `role ${r}` });
        }
        for (const p of facts.flatMap((f) => f.packages)) {
          const k = productKind(p);
          if (k !== undefined && !products.has(k.key)) products.set(k.key, { kind: k, via: `package ${p}` });
        }
        for (const { kind, via } of [...products.values()].sort((a, b) => byString(a.kind.key, b.kind.key))) {
          const pkey = `ansible:${proj}:${kind.key}@${pattern}`;
          if (!items.has(pkey)) {
            items.set(pkey, {
              key: pkey,
              group: group.key,
              tool: "ansible",
              kind: "service",
              address: `${pattern}/${kind.key}`,
              name: `${kind.name} (${pattern})`,
              category: categoryOf(kind),
              file: play.file,
              line: play.line,
              settings: { host: pattern, via },
              details: [],
              hints: [kind.key, `${pattern}-${kind.key}`],
              images: [],
              tech: [kind.name, "Ansible"],
              infraKind: kind.key,
            });
            links.push({ from: { item: key }, to: { item: pkey }, label: "runs", kind: "deploy", evidence });
            links.push({ from: { item: pkey }, to: { infraKind: kind.key }, label: "runs", kind: "deploy", evidence });
          }
        }
      }
    }
    for (const it of items.values()) it.details = uniq(it.details).sort(byString);
    for (const [g, hs] of [...inv].sort((a, b) => byString(a[0], b[0]))) {
      if (!items.has(`ansible:${proj}:hosts/${g}`) && g !== "ungrouped") group.details.push(`inventory group ${g} (${hs.length})`);
    }
    report.groups.push(group);
    report.items.push(...[...items.values()].sort((a, b) => byString(a.key, b.key)));
    report.links.push(...links);
  }
}
