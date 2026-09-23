// src/integrations/work/jira.ts — Jira Cloud REST v3. Connect verifies
// {site, email, token} with GET /rest/api/3/myself before anything is stored;
// the token goes to the Keychain (account "jira:<host>"), site + e-mail to
// integrations.json. Reads: JQL search and issue fetches. The only write is
// POST /rest/api/3/issue, reached from POST /api/work/create.
import type { ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { IntegrationError, mapLimit, obj, redact, str, arr, type Json } from "../exec.js";
import type { SecretStore } from "../keychain.js";
import type { ProjectContext, WorkCreateInput, WorkIntegration, WorkItemData } from "../registry.js";
import type { SettingsStore } from "../store.js";

const PROVIDER = "jira";
const TIMEOUT_MS = 20_000;
const FIELDS = "summary,status,assignee,updated";
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const SETUP_HINT = "Connect with your Atlassian site, e-mail and an API token (id.atlassian.com → Security → API tokens)";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** "acme" / "acme.atlassian.net" / "https://acme.atlassian.net/jira" → "https://acme.atlassian.net". */
export function normalizeSite(input: string): string {
  let text = input.trim().replace(/\/+$/, "");
  if (text.length === 0) throw new IntegrationError(400, "site is required");
  if (!/^[a-z]+:\/\//i.test(text)) text = /^[A-Za-z0-9-]+$/.test(text) ? `https://${text}.atlassian.net` : `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IntegrationError(400, "site is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") throw new IntegrationError(400, "site must not contain credentials");
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new IntegrationError(400, "site must use https");
  return `${url.protocol}//${url.host}`;
}

export function keychainAccount(site: string): string {
  return `${PROVIDER}:${new URL(site).host}`;
}

/** Plain text → Atlassian Document Format: blank lines split paragraphs, single newlines become hard breaks. */
export function toAdf(text: string): Json {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const content: Json[] = [];
      p.split("\n").forEach((line, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        if (line.length > 0) content.push({ type: "text", text: line });
      });
      return { type: "paragraph", content };
    });
  return { type: "doc", version: 1, content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [] }] };
}

/** Free text → a safe JQL `text ~ "…"` operand (quotes/backslashes and Lucene operators removed). */
export function jqlText(query: string): string {
  const cleaned = query
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"\\+\-&|!(){}[\]^~*?:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned;
}

function isoOrNow(value: string | undefined): string {
  if (value !== undefined) {
    const t = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date(0).toISOString();
}

export function mapJiraIssue(json: unknown, site: string): WorkItemData | undefined {
  const issue = obj(json);
  const key = str(issue?.key);
  if (issue === undefined || key === undefined) return undefined;
  const fields = obj(issue.fields) ?? {};
  const item: WorkItemData = {
    id: key,
    provider: PROVIDER,
    title: str(fields.summary) ?? key,
    status: str(obj(fields.status)?.name) ?? "unknown",
    url: `${site}/browse/${key}`,
    updatedAt: isoOrNow(str(fields.updated)),
  };
  const assignee = str(obj(fields.assignee)?.displayName);
  if (assignee !== undefined) item.assignee = assignee;
  return item;
}

export interface JiraDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  fetch?: typeof fetch;
}

interface Credentials {
  site: string;
  email: string;
  token: string;
}

export class JiraIntegration implements WorkIntegration {
  readonly id = PROVIDER;
  readonly family = "work" as const;
  readonly name = "Jira";

  constructor(private readonly deps: JiraDeps) {}

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  enabled(): Promise<boolean> {
    const s = this.deps.settings.get(this.id);
    return Promise.resolve(s.site !== undefined && s.email !== undefined);
  }

  private async credentials(): Promise<Credentials> {
    const { site, email } = this.deps.settings.get(this.id);
    if (site === undefined || email === undefined) throw new IntegrationError(409, "Jira is not connected");
    const token = await this.deps.secrets.get(keychainAccount(site)).catch((err: unknown) => {
      throw new IntegrationError(500, err instanceof Error ? err.message : "keychain read failed");
    });
    if (token === null) throw new IntegrationError(409, "Jira token missing from the Keychain — connect again");
    return { site, email, token };
  }

  /** One Jira REST call. Errors carry Jira's message, never the token. */
  async request(creds: Credentials, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
    const secrets = [creds.token, auth];
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(`${creds.site}${pathAndQuery}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : err instanceof Error ? err.message : "request failed";
      throw new IntegrationError(502, redact(`Jira ${new URL(creds.site).host}: ${reason}`, secrets));
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? (JSON.parse(text) as unknown) : {};
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const data = obj(json);
      const messages = [
        ...arr(data?.errorMessages).map(str),
        ...Object.entries(obj(data?.errors) ?? {}).map(([k, v]) => `${k}: ${str(v) ?? ""}`),
      ].filter((m): m is string => m !== undefined && m.length > 0);
      const detail = messages.length > 0 ? messages.join("; ") : `HTTP ${response.status}`;
      const status = response.status === 401 || response.status === 403 ? 401 : response.status === 404 ? 404 : response.status === 400 ? 400 : 502;
      throw new IntegrationError(status, redact(`Jira: ${detail.slice(0, 400)}`, secrets));
    }
    return { status: response.status, json };
  }

  async info(): Promise<IntegrationInfo> {
    const { site, email } = this.deps.settings.get(this.id);
    if (site === undefined || email === undefined) return this.base({ setupHint: SETUP_HINT });
    const accounts = [{ id: site, label: `${email} @ ${new URL(site).host}` }];
    try {
      const token = await this.deps.secrets.get(keychainAccount(site));
      if (token === null) return this.base({ detail: "token missing from the Keychain", setupHint: SETUP_HINT, accounts });
    } catch (err) {
      return this.base({ status: "error", detail: err instanceof Error ? err.message : "keychain read failed", accounts });
    }
    return this.base({ status: "connected", detail: `${new URL(site).host} as ${email}`, accounts });
  }

  async connect(body: ConnectBody): Promise<IntegrationInfo> {
    if (body.site === undefined || body.email === undefined) throw new IntegrationError(400, "Jira needs { site, email, token }");
    const site = normalizeSite(body.site);
    const email = body.email.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new IntegrationError(400, "email is not valid");
    let token = body.token?.trim();
    if (token === undefined || token.length === 0) {
      token = (await this.deps.secrets.get(keychainAccount(site))) ?? undefined;
      if (token === undefined) throw new IntegrationError(400, "Jira needs { site, email, token }");
    }
    // Verify before storing anything.
    const { json } = await this.request({ site, email, token }, "GET", "/rest/api/3/myself");
    if (obj(json)?.accountId === undefined) throw new IntegrationError(502, "Jira: unexpected /myself response");
    try {
      await this.deps.secrets.set(keychainAccount(site), token);
    } catch (err) {
      throw new IntegrationError(500, redact(err instanceof Error ? err.message : "keychain write failed", [token]));
    }
    const previous = this.deps.settings.get(this.id).site;
    if (previous !== undefined && previous !== site) await this.deps.secrets.delete(keychainAccount(previous)).catch(() => false);
    this.deps.settings.set(this.id, { site, email });
    return this.info();
  }

  async disconnect(): Promise<IntegrationInfo> {
    const { site } = this.deps.settings.get(this.id);
    if (site !== undefined) {
      try {
        await this.deps.secrets.delete(keychainAccount(site));
      } catch (err) {
        throw new IntegrationError(500, err instanceof Error ? err.message : "keychain delete failed");
      }
    }
    this.deps.settings.set(this.id, undefined);
    return this.info();
  }

  async search(query: string): Promise<WorkItemData[]> {
    const creds = await this.credentials();
    const text = jqlText(query);
    const found: WorkItemData[] = [];
    const key = query.trim().toUpperCase();
    if (ISSUE_KEY_RE.test(key)) found.push(...(await this.get([key])));
    if (text.length > 0) {
      const jql = `text ~ "${text}" ORDER BY updated DESC`;
      const params = new URLSearchParams({ jql, fields: FIELDS, maxResults: "50" });
      const { json } = await this.request(creds, "GET", `/rest/api/3/search/jql?${params.toString()}`);
      for (const issue of arr(obj(json)?.issues)) {
        const item = mapJiraIssue(issue, creds.site);
        if (item !== undefined && !found.some((f) => f.id === item.id)) found.push(item);
      }
    }
    return found;
  }

  async get(ids: readonly string[]): Promise<WorkItemData[]> {
    const keys = ids.filter((id) => ISSUE_KEY_RE.test(id));
    if (keys.length === 0) return [];
    const creds = await this.credentials();
    const items = await mapLimit(keys, 4, async (issueKey) => {
      try {
        const { json } = await this.request(creds, "GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${FIELDS}`);
        return mapJiraIssue(json, creds.site);
      } catch (err) {
        if (err instanceof IntegrationError && err.status === 404) return undefined;
        throw err;
      }
    });
    return items.filter((i): i is WorkItemData => i !== undefined);
  }

  async create(input: WorkCreateInput, _project: ProjectContext | null): Promise<WorkItemData> {
    if (input.projectKey === undefined) throw new IntegrationError(400, "Jira needs projectKey");
    const creds = await this.credentials();
    const { json } = await this.request(creds, "POST", "/rest/api/3/issue", {
      fields: {
        project: { key: input.projectKey },
        summary: input.title,
        issuetype: { name: input.issueType ?? "Task" },
        description: toAdf(input.body),
      },
    });
    const key = str(obj(json)?.key);
    if (key === undefined) throw new IntegrationError(502, "Jira: issue created but no key returned");
    const [fetched] = await this.get([key]).catch(() => []);
    return fetched ?? { id: key, provider: PROVIDER, title: input.title, status: "unknown", url: `${creds.site}/browse/${key}`, updatedAt: new Date().toISOString() };
  }

  urlFor(id: string): string {
    const { site } = this.deps.settings.get(this.id);
    return site !== undefined ? `${site}/browse/${encodeURIComponent(id)}` : "";
  }
}
