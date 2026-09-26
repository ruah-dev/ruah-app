import { z } from "zod";

// CONTRACTS.md §18 — live preview of the open project's dev server. The
// library is src/preview/* (detection, runner, static server, CLI); the daemon
// exposes it over /api/preview/* and pushes `preview` frames on /ws.

export const PREVIEW_STATES = ["stopped", "starting", "running", "crashed"] as const;
export const PreviewStateSchema = z.enum(PREVIEW_STATES);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

/** Where a candidate comes from: a package.json / deno.json script, a framework command Ruah builds, compose, the built-in static server, or the user's own command. */
export const PreviewKindSchema = z.enum(["script", "python", "ruby", "go", "compose", "deno", "static", "custom"]);
export type PreviewKind = z.infer<typeof PreviewKindSchema>;

export const PreviewCandidateSchema = z.object({
  /** Stable per repo: "<dir>#<name>" (".#dev", "apps/web#dev", "api#django", ".#static"). */
  id: z.string(),
  /** Framework or tool name for people: "Vite", "Next.js", "Django", "Static site". */
  title: z.string(),
  /** The command as shown ("pnpm run dev"); `{port}` is filled in at start. */
  command: z.string(),
  /** Repo-relative folder it runs in ("." = the root; a system: "<repoId>/<rel>"). */
  dir: z.string(),
  /** vite | next | remix | astro | sveltekit | nuxt | expo | storybook | cra | angular | webpack | gatsby | parcel | node | django | flask | fastapi | rails | go | compose | deno | static | custom */
  framework: z.string(),
  kind: PreviewKindSchema,
  /** Expected (default) port; the URL printed by the server wins. */
  port: z.number().int().optional(),
  /** The server reloads the page itself (HMR / live reload). */
  hmr: z.boolean(),
  /** Why it is offered: "package.json scripts.dev", "manage.py". */
  reason: z.string(),
  /** Higher = better default. */
  score: z.number(),
  /** Workspace package name (monorepos). */
  workspace: z.string().optional(),
  /** Extra environment ("{port}" is filled in), e.g. PORT for Rails' bin/dev. */
  env: z.record(z.string()).optional(),
  /** The program it needs on PATH ("pnpm", "python3", "docker"). */
  needs: z.string().optional(),
  /** false when `needs` is not on PATH; the start still works if it appears later. */
  available: z.boolean().optional(),
  /** How to get `needs` when it is missing. */
  install: z.string().optional(),
  /** Dependencies look missing (no node_modules): the command to run once first ("pnpm install"); never run by Ruah itself. */
  setup: z.string().optional(),
});
export type PreviewCandidate = z.infer<typeof PreviewCandidateSchema>;

/**
 * A fixed preview URL: http(s) on this computer — localhost, *.localhost,
 * 127.x.x.x or [::1], no credentials. It is framed by the viewer and checked by
 * the daemon, and `.ruah/preview.json` comes with the repo: never another
 * scheme (javascript:, file:, data:) or another machine.
 */
export function isLocalPreviewUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export const PreviewUrlSchema = z
  .string()
  .max(2048)
  .refine(isLocalPreviewUrl, { message: "must be an http(s) address on this computer (localhost, *.localhost, 127.0.0.1 or [::1])" });

/** `<repo>/.ruah/preview.json` — committable, no secrets. */
export const PreviewFileSchema = z.object({
  version: z.literal(1),
  /** A candidate id (§18.2); wins over detection's pick. */
  candidate: z.string().min(1).max(512).optional(),
  /** Your own command instead of a candidate (`{port}` allowed). */
  command: z.string().min(1).max(4096).optional(),
  /** Folder for `command` (repo-relative, default "."). */
  dir: z.string().min(1).max(1024).optional(),
  /** Fixed preview URL (e.g. "http://localhost:3000/app"; http(s) on this computer only); default: the URL the server prints. */
  url: PreviewUrlSchema.optional(),
});
export type PreviewFile = z.infer<typeof PreviewFileSchema>;

export const PreviewDetectionSchema = z.object({
  root: z.string(),
  candidates: z.array(PreviewCandidateSchema),
  /** Candidates come from more than one folder (workspaces, apps/*, api + web …). */
  monorepo: z.boolean(),
  packageManager: z.enum(["pnpm", "yarn", "npm", "bun"]).optional(),
  /** What a start without arguments runs: the saved choice, else the single obvious candidate; null = ask the user. */
  selected: z.string().nullable(),
  /** The saved choice, null when there is none: this computer's (§20.3), else the repo's `.ruah/preview.json`. */
  choice: PreviewFileSchema.nullable(),
  /** Where `choice` comes from: "local" = `$RUAH_HOME/projects/<id>/preview.json`, "repo" = `.ruah/preview.json`. */
  choiceFrom: z.enum(["local", "repo"]).optional(),
  /** `.ruah/preview.json` exists but is invalid (it is never overwritten then). */
  configError: z.string().optional(),
  /** The folder walk stopped at its bounds. */
  truncated: z.boolean(),
});
export type PreviewDetection = z.infer<typeof PreviewDetectionSchema>;

export const PreviewStatusSchema = z.object({
  projectId: z.string(),
  root: z.string(),
  /** Grows with every pushed change (0 = never started): a viewer keeps the highest it saw, so an HTTP answer that raced a newer push is ignored. */
  rev: z.number().int(),
  state: PreviewStateSchema,
  /** What runs (or ran): a candidate, or the custom command as a `custom` candidate. */
  candidate: PreviewCandidateSchema.nullable(),
  /** The command after `{port}` substitution. */
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  url: z.string().nullable(),
  port: z.number().int().nullable(),
  /** The URL answered HTTP at the last check. */
  healthy: z.boolean(),
  /** "blocked": X-Frame-Options / CSP frame-ancestors refuse an iframe (the viewer falls back to a webview or the browser). */
  framing: z.enum(["ok", "blocked", "unknown"]),
  hmr: z.boolean(),
  /** How it runs: a PTY (a "preview" tab in the terminal panel), a plain child process (node-pty missing), or the built-in static server. */
  runner: z.enum(["pty", "process", "static"]).nullable(),
  /** The terminal tab (§7) showing its output (runner "pty"). */
  terminalId: z.string().nullable(),
  pid: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  /** Why it crashed or could not start (one line). */
  error: z.string().optional(),
  /** The last output lines, ANSI stripped (≤ 40 here; GET /api/preview/logs for more). */
  logs: z.array(z.string()),
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

// ---------- HTTP bodies ----------

export const PreviewStartBodySchema = z.object({
  /** A candidate id from detection. */
  candidate: z.string().min(1).max(512).optional(),
  /** Your own command (needs the terminal token, §18.4). */
  command: z.string().min(1).max(4096).optional(),
  dir: z.string().min(1).max(1024).optional(),
  /** Also remember it as the project's choice on this computer (`$RUAH_HOME/projects/<id>/preview.json`). */
  remember: z.boolean().optional(),
  /** Save it in the repo instead (`.ruah/preview.json`, committable; replaces this computer's choice). */
  saveToRepo: z.boolean().optional(),
});
export type PreviewStartBody = z.infer<typeof PreviewStartBodySchema>;

export const PreviewChoiceBodySchema = z.object({
  /** null clears the saved candidate. */
  candidate: z.string().min(1).max(512).nullable().optional(),
  /** null clears the saved command (a command needs the terminal token). */
  command: z.string().min(1).max(4096).nullable().optional(),
  dir: z.string().min(1).max(1024).nullable().optional(),
  url: PreviewUrlSchema.nullable().optional(),
  /** Apply the patch to the repo's `.ruah/preview.json` (committable) instead of this computer's choice. */
  saveToRepo: z.boolean().optional(),
});
export type PreviewChoiceBody = z.infer<typeof PreviewChoiceBodySchema>;

/** The /ws push (§18.5): sent to every viewer on each change (logs at most ~4 times a second). */
export type PreviewServerMessage = { type: "preview"; status: PreviewStatus };
