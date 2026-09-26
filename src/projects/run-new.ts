// src/projects/run-new.ts — `ruah app new` (CONTRACTS §20.6): create a project
// from a template without the app or a daemon, through the same library as the
// wizard (src/projects/create.ts). `gh repo create` runs only with --gh.
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { CreateReport, GithubVisibility } from "../contracts/projects.js";
import { commandLine, createProjectFolder, githubCreateArgs, githubRepoName, type CreateDeps } from "./create.js";
import { ProjectError } from "./project-names.js";
import { DEFAULT_TEMPLATE, findTemplate, TEMPLATES } from "./templates/index.js";
import { resolveBin } from "../integrations/exec.js";

export const NEW_USAGE = `ruah app new — create a project from a template (no app or daemon needed)

Usage:
  ruah app new <name> [--in <dir>] [--template <id>] [--no-git] [--no-commit]
                      [--gh private|public] [--gh-name <repo>] [--system <dir>]
                      [--create-parent] [--json]
  ruah app new --templates [--json]      list the templates

  <name>             the folder to create (must not exist; nothing is ever overwritten)
  --in <dir>         where to create it (default: the current folder)
  --template <id>    ${TEMPLATES.map((t) => t.id).join(", ")} (default ${DEFAULT_TEMPLATE})
  --no-git           no git init (default: git init + an initial commit)
  --no-commit        git init without the initial commit
  --gh private|public
                     also create a GitHub repo with \`gh repo create\` and push (needs gh, logged in);
                     never runs without this flag
  --gh-name <repo>   the GitHub repo name (default: the folder name as a slug)
  --system <dir>     add the new repo to a multi-repo system (a folder with ruah.system.json)
  --create-parent    create --in when it does not exist
  --json             print the report as JSON

Exit codes: 0 created, 1 failed (nothing is left behind), 2 bad arguments.
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function pretty(p: string): string {
  const home = process.env.HOME ?? homedir();
  return home !== "" && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/**
 * A path as one shell word, for the commands the report suggests ("Payments API" has a space):
 * single-quoted when needed; a leading `~/` stays outside the quotes so the shell still expands it.
 */
export function shellPath(p: string): string {
  const quote = (s: string) => (/^[A-Za-z0-9._/:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  if (p === "~" || p === "~/") return p;
  return p.startsWith("~/") ? `~/${quote(p.slice(2))}` : quote(p);
}

export function formatReport(report: CreateReport, name: string): string[] {
  const template = findTemplate(report.template);
  const lines = [`Created ${pretty(report.path)} from "${template?.name ?? report.template}"`];
  const map = report.scanned !== null ? `map: ${report.scanned.nodes} elements, ${report.scanned.edges} links` : "map: empty (draw it in Ruah)";
  lines.push(`  ${report.files} files · ${map}`);
  if (report.git !== null) {
    lines.push(`  git: ${report.git.branch ?? "(no branch)"}${report.git.commit !== null ? ` @ ${report.git.commit} (initial commit)` : " (no commit yet)"}`);
  }
  if (report.system !== null) {
    lines.push(report.system.error === undefined ? `  system: added to ${pretty(report.system.root)} as "${report.system.repoId ?? "?"}"` : `  system: not added — ${report.system.error}`);
  }
  if (report.github !== null) {
    lines.push(report.github.error === undefined ? `  GitHub: ${report.github.url ?? "created"}` : `  GitHub: not created — ${report.github.error}`);
    if (report.github.error !== undefined) lines.push(`    retry: (cd ${shellPath(pretty(report.path))} && ${commandLine("gh", report.github.command.slice(1))})`);
  }
  for (const warning of report.warnings.filter((w) => !w.startsWith("GitHub repo not created") && !w.startsWith("Not added to the system"))) lines.push(`  ! ${warning}`);
  const run = template?.run;
  const dir = shellPath(pretty(report.path));
  lines.push(`Next: cd ${dir}${run !== undefined && !run.startsWith("open ") ? ` && ${run}` : ""}   ·   ruah app ${dir}`);
  if (report.github === null && report.git?.commit != null && resolveBin("gh") !== undefined) {
    lines.push(`To put it on GitHub: (cd ${dir} && ${commandLine("gh", githubCreateArgs(githubRepoName(name), "private", true))})`);
  }
  return lines;
}

export async function runNew(argv: readonly string[], version: string, deps: Omit<Partial<CreateDeps>, "version"> = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        in: { type: "string" },
        template: { type: "string", short: "t" },
        "no-git": { type: "boolean", default: false },
        "no-commit": { type: "boolean", default: false },
        gh: { type: "string" },
        "gh-name": { type: "string" },
        system: { type: "string" },
        "create-parent": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        templates: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ruah app new: ${(err as Error).message}\n\n${NEW_USAGE}`);
    return 2;
  }
  const v = parsed.values;
  if (v.help === true) {
    process.stdout.write(NEW_USAGE);
    return 0;
  }
  if (v.templates === true) {
    if (v.json === true) out(JSON.stringify({ templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, ...(t.run !== undefined ? { run: t.run } : {}) })) }, null, 2));
    else for (const t of TEMPLATES) out(`${t.id.padEnd(18)} ${t.name} — ${t.description}`);
    return 0;
  }
  const name = parsed.positionals[0];
  if (name === undefined || parsed.positionals.length > 1) {
    process.stderr.write(`ruah app new: ${name === undefined ? "missing <name>" : "one <name> only (quote names with spaces)"}\n\n${NEW_USAGE}`);
    return 2;
  }
  let visibility: GithubVisibility | undefined;
  if (v.gh !== undefined) {
    if (v.gh !== "private" && v.gh !== "public") {
      process.stderr.write(`ruah app new: --gh takes private or public (got "${v.gh}")\n`);
      return 2;
    }
    visibility = v.gh;
  }
  if (v.template !== undefined && findTemplate(v.template) === undefined) {
    process.stderr.write(`ruah app new: unknown template "${v.template}" (expected ${TEMPLATES.map((t) => t.id).join(", ")})\n`);
    return 2;
  }
  try {
    const report = await createProjectFolder(
      {
        parentDir: v.in ?? process.cwd(),
        name,
        template: v.template,
        git: v["no-git"] !== true,
        commit: v["no-commit"] !== true,
        ...(visibility !== undefined ? { github: { visibility, ...(v["gh-name"] !== undefined ? { name: v["gh-name"] } : {}) } } : {}),
        ...(v.system !== undefined ? { system: v.system } : {}),
        createParent: v["create-parent"] === true,
      },
      { ...deps, version },
    );
    if (v.json === true) out(JSON.stringify(report, null, 2));
    else for (const line of formatReport(report, name)) out(line);
    return 0;
  } catch (err) {
    const message = err instanceof ProjectError || err instanceof Error ? err.message : String(err);
    if (v.json === true) out(JSON.stringify({ error: message, status: err instanceof ProjectError ? err.status : 500 }));
    else process.stderr.write(`ruah app new: ${message}\n`);
    return err instanceof ProjectError && err.status === 400 ? 2 : 1;
  }
}
