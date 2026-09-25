// src/extensions/cli.ts — `ruah app ext …`: the extensions library without
// the daemon. The project is the repo around the current directory (git
// top-level, else the directory itself) or --repo <dir>. Secret values are
// read from stdin (hidden when it is a terminal), never from arguments.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  EXTENSION_AGENTS,
  EXTENSION_KINDS,
  INSTALL_TARGETS,
  type AddExtensionBody,
  type ExtensionAgent,
  type ExtensionKind,
  type ExtensionScope,
  type ExtensionView,
  type InstallTarget,
  type McpRuns,
  type ServerPreview,
} from "../contracts/extensions.js";
import { ruahHome } from "../usage/log.js";
import { supportFor } from "./agents.js";
import { runExec } from "./launcher.js";
import { AGENT_NAMES, ExtensionError, isExtensionAgent } from "./model.js";
import { ExtensionsService, projectRefFor, type ProjectRef } from "./service.js";

const USAGE = `ruah app ext — skills, MCP servers, Kiro powers, plugins and rules for the agents Ruah runs

Usage:
  ruah app ext list [--json]                       global + this project's extensions, per-agent state
  ruah app ext featured [--json]                   the curated catalog (Claude Design, GitHub, Playwright, …)
  ruah app ext discover [--agent <id>] [--json]    what each agent already has configured itself (read-only)
  ruah app ext add <folder|git-url|featured:<id>> [--kind <k>] [--id <id>] [--name <n>]
                   [--ref <branch|tag>] [--subdir <path>] [--project] [--agent <id>]... [--json]
  ruah app ext add --mcp <name> [--env NAME]... [--project] [--agent <id>]... -- <command> [args…]
  ruah app ext add --url <https://…> [--sse] [--header NAME]... [--id <id>] [--project] [--agent <id>]...
  ruah app ext show <id> [--project] [--json]      what it runs (commands, URLs, env var names), support
  ruah app ext enable <id> [--agent <id>]... [--project]
                                                   no --agent: every agent that can use it
  ruah app ext disable <id> [--agent <id>]... [--project]    no --agent: all
  ruah app ext remove <id> [--project] [--keep-installs]
  ruah app ext fetch <id> [--project]              clone a git extension that is not on this machine yet
  ruah app ext secret set <id> <NAME> [--project]  value from stdin → macOS Keychain
  ruah app ext secret delete <id> <NAME> [--project]
  ruah app ext install-into <id> --target claude-code|cursor|kiro [--global] [--project]
                                                   also write it into that tool's own config (explicit)
  ruah app ext preview --agent <id> [--json]       what a session of that agent receives now

Options:
  --project        the extension lives in <repo>/.ruah/extensions.json (committable) instead of
                   $RUAH_HOME/extensions.json
  --repo <dir>     the project folder (default: the git repo around the current directory)
  --agent <id>     ${EXTENSION_AGENTS.join(", ")}
  <k>              ${EXTENSION_KINDS.join(", ")}

Adding never runs anything (git sources are only cloned, into $RUAH_HOME/extensions/src).
An extension reaches an agent when you enable it for that agent; what it runs is shown first and
re-approval is needed when it changes.
`;

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, ".ruah", "extensions.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function describeServer(s: ServerPreview): string {
  const target = s.transport === "stdio" ? [s.command ?? "", ...(s.args ?? [])].map(quote).join(" ") : `${s.transport.toUpperCase()} ${s.url ?? ""}`;
  const env = s.env.length > 0 ? `  env: ${s.env.join(", ")}` : "";
  const headers = (s.headers ?? []).length > 0 ? `  headers: ${(s.headers ?? []).join(", ")}` : "";
  return `${s.name}: ${target}${env}${headers}`;
}

function quote(arg: string): string {
  return /^[A-Za-z0-9_./:@%+=,${}-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function agentList(values: unknown): ExtensionAgent[] | string {
  const raw = (Array.isArray(values) ? values : []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter((v) => v.length > 0);
  const bad = raw.find((v) => !isExtensionAgent(v));
  if (bad !== undefined) return `unknown agent "${bad}" (expected ${EXTENSION_AGENTS.join(", ")})`;
  return [...new Set(raw)] as ExtensionAgent[];
}

function printView(v: ExtensionView, out: (line: string) => void): void {
  const status = v.status === "ready" ? "" : `  [${v.status}${v.statusDetail !== undefined ? `: ${v.statusDetail}` : ""}]`;
  out(`${v.id}  ${v.kind}  ${v.scope}${status}`);
  out(`  ${v.name}${v.description !== undefined ? ` — ${v.description.split("\n")[0]?.slice(0, 100) ?? ""}` : ""}`);
  out(`  enabled for: ${v.enabledFor.length > 0 ? v.enabledFor.join(", ") : "(none)"}`);
  for (const s of v.what.servers) out(`  runs ${describeServer(s)}`);
  if (v.what.launcher) out("  (stdio servers start through `ruah app ext exec`, which reads their secrets from the Keychain)");
  for (const h of v.what.hooks) out(`  hook ${h}`);
  for (const s of v.secrets) out(`  secret ${s.name}: ${s.set ? "in Keychain" : s.fromEnv ? "from environment" : "not set"}`);
  if (v.notes !== undefined) out(`  note: ${v.notes}`);
}

async function readSecretValue(name: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(`Value for ${name} (hidden): `);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err !== undefined) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export interface ExtCliDeps {
  service?: ExtensionsService;
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  readSecret?: (name: string) => Promise<string>;
}

export async function runExt(argv: readonly string[], deps: ExtCliDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (cmd === "exec") return runExec(rest);
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE.trimEnd());
    return cmd === undefined ? 2 : 0;
  }

  // Split off `-- <command> [args…]` (add --mcp) before parsing options.
  const dashdash = rest.indexOf("--");
  const optionArgs = dashdash === -1 ? rest : rest.slice(0, dashdash);
  const commandArgs = dashdash === -1 ? [] : rest.slice(dashdash + 1);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...optionArgs],
      options: {
        json: { type: "boolean", default: false },
        project: { type: "boolean", default: false },
        global: { type: "boolean", default: false },
        repo: { type: "string" },
        agent: { type: "string", multiple: true, default: [] },
        kind: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        ref: { type: "string" },
        subdir: { type: "string" },
        mcp: { type: "string" },
        url: { type: "string" },
        sse: { type: "boolean", default: false },
        env: { type: "string", multiple: true, default: [] },
        header: { type: "string", multiple: true, default: [] },
        target: { type: "string" },
        "keep-installs": { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    err(`ruah app ext: ${(e as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const cwd = deps.cwd ?? process.cwd();
  const project: ProjectRef = projectRefFor(values.repo !== undefined ? path.resolve(cwd, values.repo) : findRepoRoot(cwd));
  const scope: ExtensionScope = values.project === true ? "project" : "global";
  const agents = agentList(values.agent);
  if (typeof agents === "string") {
    err(`ruah app ext: ${agents}`);
    return 2;
  }
  const service = deps.service ?? new ExtensionsService({ home: ruahHome() });
  const json = values.json === true;
  const print = (value: unknown): void => out(JSON.stringify(value, null, 2));

  try {
    switch (cmd) {
      case "list": {
        const list = await service.list(project);
        if (json) return print(list), 0;
        for (const e of list.errors) err(`${e.file}: ${e.error}`);
        if (list.installed.length === 0) {
          out("No extensions yet. Try `ruah app ext featured`, then `ruah app ext add featured:<id> --agent claude`.");
          return 0;
        }
        for (const v of list.installed) {
          printView(v, out);
          out("");
        }
        return 0;
      }
      case "featured": {
        const featured = service.featured(project);
        if (json) return print(featured), 0;
        for (const f of featured) {
          const runs = f.runs === undefined ? "" : f.runs.type === "stdio" ? `${f.runs.command} ${f.runs.args.join(" ")}` : f.runs.url;
          out(`${f.id.padEnd(20)} ${f.kind.padEnd(6)} ${f.name}${f.added === true ? "  (added)" : ""}`);
          out(`${"".padEnd(28)}${f.description}`);
          if (runs.length > 0) out(`${"".padEnd(28)}runs: ${runs}${(f.env ?? []).length > 0 ? `  env: ${(f.env ?? []).join(", ")}` : ""}`);
        }
        return 0;
      }
      case "discover": {
        const found = service.discover(project, agents.length > 0 ? agents : undefined);
        if (json) return print(found), 0;
        for (const agent of found) {
          out(`${agent.name}${agent.installed ? "" : " (not installed)"}`);
          if (agent.items.length === 0) out("  nothing configured");
          for (const item of agent.items) {
            const runs = item.runs !== undefined ? `  ${describeServer(item.runs).replace(/^[^:]+: /, "")}` : "";
            out(`  ${item.kind.padEnd(6)} ${item.name}  (${item.scope}${item.enabled === false ? ", disabled" : ""})${runs}`);
          }
          for (const e of agent.errors) err(`  ${e}`);
        }
        return 0;
      }
      case "add": {
        let body: AddExtensionBody;
        const common = {
          scope,
          ...(values.id !== undefined ? { id: values.id } : {}),
          ...(values.name !== undefined ? { name: values.name } : {}),
          ...(agents.length > 0 ? { enableFor: agents } : {}),
        };
        if (values.mcp !== undefined) {
          const [command, ...args] = commandArgs;
          if (command === undefined) {
            err("ruah app ext add --mcp <name>: put the command after --, e.g. -- npx -y @playwright/mcp@latest");
            return 2;
          }
          const runs: McpRuns = { type: "stdio", command, args };
          body = { ...common, name: values.name ?? values.mcp, id: values.id ?? values.mcp, source: { type: "inline", runs, env: values.env ?? [] } } as AddExtensionBody;
        } else if (values.url !== undefined) {
          const headers = values.header ?? [];
          const runs: McpRuns = { type: values.sse === true ? "sse" : "http", url: values.url, ...(headers.length > 0 ? { headers } : {}) };
          body = { ...common, source: { type: "inline", runs } } as AddExtensionBody;
        } else {
          const source = positionals[0];
          if (source === undefined) {
            err("ruah app ext add: missing <folder|git-url|featured:<id>>");
            return 2;
          }
          if (values.kind !== undefined && !(EXTENSION_KINDS as readonly string[]).includes(values.kind)) {
            err(`ruah app ext add: unknown kind "${values.kind}"`);
            return 2;
          }
          const kind = values.kind as ExtensionKind | undefined;
          const isGit = /^(https:\/\/|ssh:\/\/|git@)/.test(source);
          body = {
            ...common,
            ...(kind !== undefined ? { kind } : {}),
            source: source.startsWith("featured:")
              ? { type: "featured", id: source.slice("featured:".length) }
              : isGit
                ? { type: "git", url: source, ...(values.ref !== undefined ? { ref: values.ref } : {}), ...(values.subdir !== undefined ? { subdir: values.subdir } : {}) }
                : { type: "local", path: path.resolve(cwd, source) },
          } as AddExtensionBody;
        }
        const view = await service.add(body, project, { cwd });
        if (json) return print(view), 0;
        out(`Added ${view.id} (${view.kind}, ${view.scope}). Nothing was run.`);
        printView(view, out);
        if (view.enabledFor.length === 0) out(`\nEnable it: ruah app ext enable ${view.id}${scope === "project" ? " --project" : ""} --agent claude`);
        for (const s of view.secrets.filter((x) => !x.set && !x.fromEnv)) out(`Set ${s.name}: ruah app ext secret set ${view.id} ${s.name}${scope === "project" ? " --project" : ""}`);
        return 0;
      }
      case "show": {
        const id = positionals[0];
        if (id === undefined) return err("ruah app ext show: missing <id>"), 2;
        const view = (await service.list(project)).installed.find((v) => v.id === id && v.scope === scope);
        if (view === undefined) return err(`ruah app ext: no ${scope} extension "${id}"`), 1;
        if (json) return print(view), 0;
        printView(view, out);
        out("  per agent:");
        for (const agent of EXTENSION_AGENTS) {
          const support = view.support[agent];
          out(`    ${AGENT_NAMES[agent].padEnd(13)} ${view.enabledFor.includes(agent) ? "on " : "off"}  ${support.delivery.padEnd(8)} ${support.note}`);
        }
        return 0;
      }
      case "enable": {
        const id = positionals[0];
        if (id === undefined) return err("ruah app ext enable: missing <id>"), 2;
        let wanted = agents;
        if (wanted.length === 0) {
          const current = (await service.list(project)).installed.find((v) => v.id === id && v.scope === scope);
          if (current === undefined) return err(`ruah app ext: no ${scope} extension "${id}"`), 1;
          wanted = EXTENSION_AGENTS.filter((a) => supportFor(current.kind, a, current.runs).delivery !== "none");
        }
        const view = await service.enable(id, scope, wanted, project);
        if (json) return print(view), 0;
        out(`${id}: enabled for ${view.enabledFor.join(", ")}`);
        for (const s of view.what.servers) out(`  runs ${describeServer(s)}`);
        return 0;
      }
      case "disable": {
        const id = positionals[0];
        if (id === undefined) return err("ruah app ext disable: missing <id>"), 2;
        const view = await service.disable(id, scope, agents.length > 0 ? agents : undefined, project);
        if (json) return print(view), 0;
        out(`${id}: enabled for ${view.enabledFor.length > 0 ? view.enabledFor.join(", ") : "(none)"}`);
        return 0;
      }
      case "remove": {
        const id = positionals[0];
        if (id === undefined) return err("ruah app ext remove: missing <id>"), 2;
        const result = await service.remove(id, scope, project, { uninstall: values["keep-installs"] !== true });
        if (json) return print(result), 0;
        out(`Removed ${id}.`);
        for (const note of result.notes) out(`  ${note}`);
        return 0;
      }
      case "fetch": {
        const id = positionals[0];
        if (id === undefined) return err("ruah app ext fetch: missing <id>"), 2;
        const view = await service.fetch(id, scope, project);
        if (json) return print(view), 0;
        printView(view, out);
        return 0;
      }
      case "secret": {
        const [action, id, name] = positionals;
        if ((action !== "set" && action !== "delete") || id === undefined || name === undefined) {
          err("ruah app ext secret set|delete <id> <NAME> [--project]");
          return 2;
        }
        if (action === "delete") {
          const deleted = await service.deleteSecret(id, scope, name, project);
          out(deleted ? `Deleted ${name} for ${id}.` : `No ${name} stored for ${id}.`);
          return 0;
        }
        const value = await (deps.readSecret ?? readSecretValue)(name);
        if (value.length === 0) return err("ruah app ext secret: empty value"), 2;
        await service.setSecret(id, scope, name, value, project);
        out(`Saved ${name} for ${id} in the Keychain.`);
        return 0;
      }
      case "install-into": {
        const id = positionals[0];
        const target = values.target;
        if (id === undefined || target === undefined || !(INSTALL_TARGETS as readonly string[]).includes(target)) {
          err(`ruah app ext install-into <id> --target ${INSTALL_TARGETS.join("|")} [--global]`);
          return 2;
        }
        const result = await service.installInto(id, scope, target as InstallTarget, values.global === true ? "global" : "project", project);
        if (json) return print({ written: result.written, notes: result.notes }), 0;
        for (const w of result.written) out(`wrote ${w}`);
        for (const n of result.notes) out(`note: ${n}`);
        return 0;
      }
      case "preview": {
        const agent = agents[0];
        if (agent === undefined) return err("ruah app ext preview --agent <id>"), 2;
        const preview = await service.preview(agent, project);
        if (json) return print(preview), 0;
        out(`${AGENT_NAMES[agent]} in ${project.root}:`);
        for (const s of preview.servers) out(`  mcp    ${describeServer(s)}`);
        for (const p of preview.plugins) out(`  plugin ${p}`);
        for (const r of preview.rules) out(`  rule   ${r}`);
        for (const s of preview.skipped) out(`  skipped ${s.id}: ${s.reason}`);
        for (const n of preview.notes) out(`  note: ${n}`);
        if (preview.servers.length + preview.plugins.length + preview.rules.length === 0) out("  nothing is injected");
        return 0;
      }
      default:
        out(USAGE.trimEnd());
        return 2;
    }
  } catch (e) {
    if (e instanceof ExtensionError) {
      err(`ruah app ext: ${e.message}`);
      return e.status === 404 ? 1 : e.status >= 500 ? 1 : 2;
    }
    err(`ruah app ext: ${(e as Error).message}`);
    return 1;
  }
}
