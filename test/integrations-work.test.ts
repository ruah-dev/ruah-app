import { afterEach, describe, expect, test } from "vitest";
import * as http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Architecture } from "../src/contracts/architecture.js";
import type { RunResult, Runner } from "../src/integrations/exec.js";
import { IntegrationRegistry, IntegrationsService } from "../src/integrations/index.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";
import { formatLinks, linksFileOf, readLinks, SettingsStore, updateLink } from "../src/integrations/store.js";
import { GitHubIntegration, mapGhIssue, parseGitRemote, repoSpec } from "../src/integrations/work/github.js";
import { JiraIntegration, jqlText, keychainAccount, mapJiraIssue, normalizeSite, toAdf } from "../src/integrations/work/jira.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-work-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TOKEN = ["jira", "api", "token", "0123456789"].join("-");
const EMAIL = "dev@example.com";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

const arch: Architecture = {
  version: 1,
  name: "acme",
  nodes: [
    { id: "api", type: "service", name: "invoices-api" },
    { id: "web", type: "frontend", name: "web-app" },
  ],
  edges: [],
  workflows: [],
};

// ---- fake Jira Cloud ------------------------------------------------------------

interface FakeJira {
  site: string;
  requests: { method: string; url: string; auth: string | undefined; body: unknown }[];
  issues: Map<string, { summary: string; status: string; assignee?: string; updated: string }>;
}

async function fakeJira(): Promise<FakeJira> {
  const state: FakeJira = { site: "", requests: [], issues: new Map() };
  state.issues.set("PLAT-1", { summary: "Fix currency enum", status: "In Progress", assignee: "Ana", updated: "2026-09-20T10:00:00.000+0000" });
  state.issues.set("PLAT-2", { summary: "Invoice PDF export", status: "To Do", updated: "2026-09-21T08:30:00.000+0200" });
  const issueJson = (key: string) => {
    const i = state.issues.get(key);
    return i === undefined ? undefined : {
      id: "10001", key, self: `${state.site}/rest/api/3/issue/${key}`,
      fields: { summary: i.summary, status: { name: i.status }, assignee: i.assignee !== undefined ? { displayName: i.assignee } : null, updated: i.updated },
    };
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString(); });
    req.on("end", () => {
      const body = raw.length > 0 ? JSON.parse(raw) as unknown : undefined;
      state.requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Basic ${BASIC}`) return send(401, { errorMessages: ["Client must be authenticated to access this resource."] });
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/rest/api/3/myself") return send(200, { accountId: "abc", emailAddress: EMAIL, displayName: "Dev" });
      if (url.pathname === "/rest/api/3/search/jql") {
        const jql = url.searchParams.get("jql") ?? "";
        const text = /text ~ "([^"]*)"/.exec(jql)?.[1]?.toLowerCase() ?? "";
        const hits = [...state.issues.keys()].filter((k) => state.issues.get(k)?.summary.toLowerCase().includes(text));
        return send(200, { issues: hits.map(issueJson), isLast: true });
      }
      const issueMatch = /^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/.exec(url.pathname);
      if (issueMatch !== null && req.method === "GET") {
        const found = issueJson(issueMatch[1] ?? "");
        return found !== undefined ? send(200, found) : send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      }
      if (url.pathname === "/rest/api/3/issue" && req.method === "POST") {
        const fields = (body as { fields: { project: { key: string }; summary: string } }).fields;
        if (fields.project.key !== "PLAT") return send(400, { errorMessages: [], errors: { project: "valid project is required" } });
        const key = `PLAT-${state.issues.size + 1}`;
        state.issues.set(key, { summary: fields.summary, status: "To Do", updated: "2026-09-23T09:00:00.000+0000" });
        return send(201, { id: "10100", key, self: `${state.site}/rest/api/3/issue/${key}` });
      }
      send(404, { errorMessages: ["not found"] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  state.site = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return state;
}

describe("Jira helpers", () => {
  test("normalizeSite", () => {
    expect(normalizeSite("acme")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("https://acme.atlassian.net/jira/software")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normalizeSite("http://acme.atlassian.net")).toThrow(/https/);
    expect(() => normalizeSite("https://user:pw@acme.atlassian.net")).toThrow(/credentials/);
    expect(keychainAccount("https://acme.atlassian.net")).toBe("jira:acme.atlassian.net");
  });

  test("jqlText strips quotes, backslashes and Lucene operators", () => {
    expect(jqlText('currency" OR project = X \\ ~*')).toBe("currency OR project = X");
    expect(jqlText("  enum  ")).toBe("enum");
  });

  test("toAdf: paragraphs and hard breaks", () => {
    expect(toAdf("Line 1\nLine 2\n\nPara 2")).toEqual({
      type: "doc", version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line 1" }, { type: "hardBreak" }, { type: "text", text: "Line 2" }] },
        { type: "paragraph", content: [{ type: "text", text: "Para 2" }] },
      ],
    });
    expect(toAdf("")).toEqual({ type: "doc", version: 1, content: [{ type: "paragraph", content: [] }] });
  });

  test("mapJiraIssue normalizes Jira's +0000 timestamps", () => {
    const item = mapJiraIssue({ key: "PLAT-9", fields: { summary: "S", status: { name: "Done" }, updated: "2026-09-21T08:30:00.000+0200" } }, "https://acme.atlassian.net");
    expect(item).toEqual({ id: "PLAT-9", provider: "jira", title: "S", status: "Done", url: "https://acme.atlassian.net/browse/PLAT-9", updatedAt: "2026-09-21T06:30:00.000Z" });
    expect(mapJiraIssue({ nokey: true }, "x")).toBeUndefined();
  });
});

describe("Jira integration (local fake server)", () => {
  test("connect verifies via /myself before storing; token → secret store only; settings hold no secret", async () => {
    const jira = await fakeJira();
    const home = tempDir();
    const settings = new SettingsStore(home);
    const secrets = new MemorySecretStore();
    const i = new JiraIntegration({ settings, secrets });

    const bad = (await i.connect({ site: jira.site, email: EMAIL, token: "wrong-token-value" }).then(() => undefined, (e: unknown) => e)) as Error;
    expect(bad.message).toMatch(/Jira: Client must be authenticated/);
    expect(bad.message).not.toContain("wrong-token-value");
    expect(secrets.secrets.size).toBe(0);

    const info = await i.connect({ site: jira.site, email: EMAIL, token: TOKEN });
    expect(info).toMatchObject({ id: "jira", status: "connected", detail: `${new URL(jira.site).host} as ${EMAIL}` });
    expect(secrets.secrets.get(`jira:${new URL(jira.site).host}`)).toBe(TOKEN);
    const onDisk = readFileSync(settings.file, "utf8");
    expect(onDisk).not.toContain(TOKEN);
    expect(JSON.parse(onDisk)).toEqual({ version: 1, providers: { jira: { site: jira.site, email: EMAIL } } });

    await i.disconnect();
    expect(secrets.secrets.size).toBe(0);
    expect((await i.info()).status).toBe("not_connected");
  });

  test("search (JQL text + key lookup), get (404 tolerated), create (ADF body)", async () => {
    const jira = await fakeJira();
    const i = new JiraIntegration({ settings: new SettingsStore(tempDir()), secrets: new MemorySecretStore() });
    await i.connect({ site: jira.site, email: EMAIL, token: TOKEN });

    const found = await i.search("currency");
    expect(found.map((f) => [f.id, f.status, f.assignee])).toEqual([["PLAT-1", "In Progress", "Ana"]]);
    const searchReq = jira.requests.find((r) => r.url.startsWith("/rest/api/3/search/jql"));
    expect(new URL(searchReq?.url ?? "", "http://x").searchParams.get("jql")).toBe('text ~ "currency" ORDER BY updated DESC');

    expect((await i.search("plat-2")).map((f) => f.id)).toEqual(["PLAT-2"]);
    expect((await i.get(["PLAT-2", "PLAT-99", "not a key"])).map((f) => f.id)).toEqual(["PLAT-2"]);

    const created = await i.create({ projectKey: "PLAT", title: "Validate currency", body: "From Ruah\n\nElement: api" }, null);
    expect(created).toMatchObject({ id: "PLAT-3", title: "Validate currency", status: "To Do", url: `${jira.site}/browse/PLAT-3` });
    const post = jira.requests.find((r) => r.method === "POST");
    expect(post?.body).toMatchObject({ fields: { project: { key: "PLAT" }, issuetype: { name: "Task" }, description: { type: "doc", version: 1 } } });
    await expect(i.create({ projectKey: "NOPE", title: "x", body: "" }, null)).rejects.toThrow(/project: valid project is required/);
    // Every request was authenticated; no request outside the fake site.
    expect(jira.requests.every((r) => r.auth === `Basic ${BASIC}`)).toBe(true);
  });

  test("no network in info(); missing token reported", async () => {
    const settings = new SettingsStore(tempDir());
    settings.set("jira", { site: "https://acme.atlassian.net", email: EMAIL });
    const i = new JiraIntegration({ settings, secrets: new MemorySecretStore(), fetch: () => Promise.reject(new Error("no network expected")) });
    expect(await i.info()).toMatchObject({ status: "not_connected", detail: "token missing from the Keychain" });
  });
});

// ---- GitHub ------------------------------------------------------------------------

describe("GitHub helpers", () => {
  test("parseGitRemote / repoSpec", () => {
    expect(parseGitRemote("git@github.com:acme/platform.git")).toEqual({ host: "github.com", owner: "acme", repo: "platform" });
    expect(parseGitRemote("https://github.com/acme/platform")).toEqual({ host: "github.com", owner: "acme", repo: "platform" });
    expect(parseGitRemote("ssh://git@ghe.acme.io/team/app.git")).toEqual({ host: "ghe.acme.io", owner: "team", repo: "app" });
    expect(parseGitRemote("/local/path/repo")).toBeUndefined();
    expect(repoSpec({ host: "github.com", owner: "a", repo: "b" })).toBe("a/b");
    expect(repoSpec({ host: "ghe.acme.io", owner: "a", repo: "b" })).toBe("ghe.acme.io/a/b");
  });

  test("mapGhIssue", () => {
    expect(mapGhIssue({ number: 42, title: "Flaky enum", state: "OPEN", url: "https://github.com/a/b/issues/42", assignees: [{ login: "ana" }], updatedAt: "2026-09-22T10:00:00Z" }, "a/b")).toEqual({
      id: "a/b#42", provider: "github", title: "Flaky enum", status: "open", url: "https://github.com/a/b/issues/42", assignee: "ana", updatedAt: "2026-09-22T10:00:00Z",
    });
  });
});

function ghRunner(remote: string | null): Runner & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const ok = (v: unknown): RunResult => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
  const runner = ((file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    if (file === "/fake/git") {
      if (args.includes("get-url")) return Promise.resolve(remote !== null ? ok(`${remote}\n`) : { code: 2, stdout: "", stderr: "error: No such remote 'origin'" });
      return Promise.resolve(ok(""));
    }
    const [a, b] = args;
    if (a === "auth") return Promise.resolve(ok({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "dev", tokenSource: "keyring" }] } }));
    if (a === "issue" && b === "list") return Promise.resolve(ok([{ number: 7, title: "Currency bug", state: "OPEN", url: "https://github.com/acme/platform/issues/7", assignees: [], updatedAt: "2026-09-22T10:00:00Z" }]));
    if (a === "issue" && b === "view") {
      const n = args[2];
      return Promise.resolve(n === "404" ? { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to an issue" } : ok({ number: Number(n), title: `Issue ${n}`, state: "OPEN", url: `https://github.com/acme/platform/issues/${n}`, assignees: [], updatedAt: "2026-09-22T10:00:00Z" }));
    }
    if (a === "issue" && b === "create") return Promise.resolve(ok("Creating issue in acme/platform\n\nhttps://github.com/acme/platform/issues/8\n"));
    return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` });
  }) as Runner & { calls: { file: string; args: string[] }[] };
  runner.calls = calls;
  return runner;
}

describe("GitHub integration (fake gh/git)", () => {
  const project = { root: "/repo" };

  test("status: connected with login + repo from the git remote; cli_missing without gh", async () => {
    const settings = new SettingsStore(tempDir());
    const gh = new GitHubIntegration({ runner: ghRunner("git@github.com:acme/platform.git"), settings, bin: () => "/fake/gh", gitBin: () => "/fake/git" });
    expect(await gh.info(project)).toMatchObject({ status: "connected", detail: "github.com as dev · repo acme/platform", accounts: [{ id: "github.com", label: "dev@github.com" }] });
    const noRemote = new GitHubIntegration({ runner: ghRunner(null), settings, bin: () => "/fake/gh", gitBin: () => "/fake/git" });
    expect((await noRemote.info(project)).detail).toContain("no GitHub remote");
    await expect(noRemote.search("x", project)).rejects.toMatchObject({ status: 409 });
    const missing = new GitHubIntegration({ runner: ghRunner(null), settings, bin: () => undefined, gitBin: () => "/fake/git" });
    expect(await missing.info(project)).toMatchObject({ status: "cli_missing", setupHint: "brew install gh && gh auth login" });
  });

  test("search/create pass user text only as --flag=value (never as a separate, flag-parsable arg)", async () => {
    const runner = ghRunner("https://github.com/acme/platform.git");
    const gh = new GitHubIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gh", gitBin: () => "/fake/git" });
    const items = await gh.search("--web currency", project);
    expect(items.map((i) => i.id)).toEqual(["acme/platform#7"]);
    const list = runner.calls.find((c) => c.args[1] === "list");
    expect(list?.args).toEqual(["issue", "list", "--repo=acme/platform", "--state=all", "--search=--web currency", "--json=number,title,state,url,assignees,updatedAt", "--limit=50"]);

    const created = await gh.create({ title: "-t evil", body: "--body-file /etc/passwd" }, project);
    expect(created).toMatchObject({ id: "acme/platform#8", title: "Issue 8" });
    const create = runner.calls.find((c) => c.args[1] === "create");
    expect(create?.args).toEqual(["issue", "create", "--repo=acme/platform", "--title=-t evil", "--body=--body-file /etc/passwd"]);
    expect((await gh.get(["acme/platform#404", "acme/platform#5", "bad"])).map((i) => i.id)).toEqual(["acme/platform#5"]);
    expect(gh.urlFor("acme/platform#5")).toBe("https://github.com/acme/platform/issues/5");
  });
});

// ---- links.json + service --------------------------------------------------------------

describe("links.json", () => {
  test("sorted, de-duplicated, stable formatting; only rewritten on change", () => {
    expect(formatLinks([
      { nodeId: "web", provider: "jira", itemId: "PLAT-10" },
      { nodeId: "api", provider: "jira", itemId: "PLAT-9" },
      { nodeId: "api", provider: "github", itemId: "a/b#2" },
      { nodeId: "api", provider: "jira", itemId: "PLAT-10" },
      { nodeId: "api", provider: "jira", itemId: "PLAT-9" },
    ])).toBe(`{
  "version": 1,
  "links": [
    {
      "nodeId": "api",
      "provider": "github",
      "itemId": "a/b#2"
    },
    {
      "nodeId": "api",
      "provider": "jira",
      "itemId": "PLAT-9"
    },
    {
      "nodeId": "api",
      "provider": "jira",
      "itemId": "PLAT-10"
    },
    {
      "nodeId": "web",
      "provider": "jira",
      "itemId": "PLAT-10"
    }
  ]
}
`);
    const root = tempDir();
    expect(readLinks(root)).toEqual([]);
    updateLink(root, { nodeId: "web", provider: "jira", itemId: "PLAT-2" }, true);
    updateLink(root, { nodeId: "api", provider: "jira", itemId: "PLAT-1" }, true);
    updateLink(root, { nodeId: "api", provider: "jira", itemId: "PLAT-1" }, true);
    expect(readLinks(root).map((l) => l.itemId)).toEqual(["PLAT-1", "PLAT-2"]);
    updateLink(root, { nodeId: "web", provider: "jira", itemId: "PLAT-2" }, false);
    expect(readFileSync(linksFileOf(root), "utf8")).toBe(formatLinks([{ nodeId: "api", provider: "jira", itemId: "PLAT-1" }]));
  });
});

describe("IntegrationsService work endpoints", () => {
  test("link / linked items (with stubs for unreachable items) / search annotates links / create links to the element", async () => {
    const jira = await fakeJira();
    const home = tempDir();
    const root = tempDir();
    const settings = new SettingsStore(home);
    const secrets = new MemorySecretStore();
    const registry = new IntegrationRegistry()
      .register(new JiraIntegration({ settings, secrets }))
      .register(new GitHubIntegration({ runner: ghRunner("git@github.com:acme/platform.git"), settings, bin: () => "/fake/gh", gitBin: () => "/fake/git" }));
    const svc = new IntegrationsService({ home, project: () => ({ root, architecture: arch }), secrets, registry });
    await svc.connect("jira", { site: jira.site, email: EMAIL, token: TOKEN });

    await svc.workLink({ provider: "jira", itemId: "PLAT-1", nodeId: "api", linked: true });
    await svc.workLink({ provider: "jira", itemId: "PLAT-77", nodeId: "api", linked: true });
    await svc.workLink({ provider: "github", itemId: "acme/platform#5", nodeId: "web", linked: true });
    await expect(svc.workLink({ provider: "jira", itemId: "PLAT-1", nodeId: "ghost", linked: true })).rejects.toMatchObject({ status: 400 });
    await expect(svc.workLink({ provider: "digitalocean", itemId: "x", nodeId: "api", linked: true })).rejects.toMatchObject({ status: 404 });

    const forApi = await svc.workItems({ nodeId: "api" });
    expect(forApi.items.map((i) => [i.id, i.title, i.linkedNodeIds])).toEqual([
      ["PLAT-1", "Fix currency enum", ["api"]],
      ["PLAT-77", "PLAT-77", ["api"]], // stub: item gone, link kept so it can be removed
    ]);
    expect(forApi.items[1]?.url).toBe(`${jira.site}/browse/PLAT-77`);

    const search = await svc.workItems({ q: "currency" });
    expect(search.items.map((i) => [i.provider, i.id, i.linkedNodeIds])).toEqual(
      expect.arrayContaining([["jira", "PLAT-1", ["api"]], ["github", "acme/platform#7", []]]),
    );

    const created = await svc.workCreate({ provider: "jira", projectKey: "PLAT", title: "New", body: "b", nodeId: "web" });
    expect(created).toMatchObject({ id: "PLAT-3", linkedNodeIds: ["web"] });
    const createdGh = await svc.workCreate({ provider: "github", title: "New gh", body: "b", nodeId: "api" });
    expect(createdGh).toMatchObject({ id: "acme/platform#8", linkedNodeIds: ["api"] });
    expect(readLinks(root).map((l) => `${l.nodeId}:${l.itemId}`)).toEqual(["api:acme/platform#8", "api:PLAT-1", "api:PLAT-77", "web:acme/platform#5", "web:PLAT-3"]);
  });
});
