import { z } from "zod";
import { ChatInfoSchema, ProjectInfoSchema } from "./ws.js";

// CONTRACTS.md §5 — projects and chats. The §5.1 types live in ws.ts (the
// WebSocket messages carry them; ws.ts must not import this file) and are
// re-exported here.
export {
  ProjectKindSchema,
  ProjectInfoSchema,
  ChatInfoSchema,
  TurnRecordSchema,
  type ProjectKind,
  type ProjectInfo,
  type ChatInfo,
  type TurnRecord,
} from "./ws.js";

// ---------- §5.3 HTTP bodies and results ----------

export const ProjectsListSchema = z.object({
  current: ProjectInfoSchema.nullable(),
  recent: z.array(ProjectInfoSchema), // most recent first, pinned on top
});
export type ProjectsList = z.infer<typeof ProjectsListSchema>;

export const OpenProjectBodySchema = z.object({
  path: z.string().min(1),
  /** Open the project on this chat (one step: switch project + chat.open). Unknown ids are ignored. */
  chatId: z.string().min(1).max(64).optional(),
});
export const GithubVisibilitySchema = z.enum(["private", "public"]);
export type GithubVisibility = z.infer<typeof GithubVisibilitySchema>;

export const CreateProjectBodySchema = z.object({
  parentDir: z.string().min(1),
  name: z.string().min(1),
  git: z.boolean().optional(),
  // §20 (all optional, additive): the new project wizard
  template: z.string().min(1).max(64).optional(), // a template id (GET /api/projects/new); default "empty"
  commit: z.boolean().optional(), // initial commit after git init (default: = git)
  /** Runs `gh repo create` — only when present (the wizard's explicit toggle; never by default). */
  github: z.object({ visibility: GithubVisibilitySchema, name: z.string().min(1).max(100).optional() }).optional(),
  /** A multi-repo system (the folder holding ruah.system.json) to add the new repo to. */
  system: z.string().min(1).max(4096).optional(),
  /** Create the parent folder when it does not exist (default false: 404). */
  createParent: z.boolean().optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export const PinProjectBodySchema = z.object({ id: z.string().min(1), pinned: z.boolean().optional() });
export const ForgetProjectBodySchema = z.object({ id: z.string().min(1) });

// ---------- §20 new project wizard, pinned order, tags, overview ----------

export const TemplateInfoSchema = z.object({
  id: z.string(),
  name: z.string(), // "Web app (Vite + React + TS)"
  description: z.string(),
  /** Top-level files and folders it writes (preview in the wizard). */
  files: z.array(z.string()),
  /** How to run it once dependencies are installed ("pnpm install && pnpm dev"); absent = nothing to run. */
  run: z.string().optional(),
  /** The wizard's suggested first prompt for the agent ("Set up the project…"). */
  setupPrompt: z.string(),
});
export type TemplateInfo = z.infer<typeof TemplateInfoSchema>;

export const ToolStatusSchema = z.object({
  git: z.object({ installed: z.boolean(), identity: z.boolean() }), // identity = user.name + user.email set (needed to commit)
  gh: z.object({ installed: z.boolean(), loggedIn: z.boolean(), login: z.string().optional() }).optional(), // only from GET /api/projects/new/github
});
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** GET /api/projects/new — what the wizard needs before the first keystroke. */
export const NewProjectDefaultsSchema = z.object({
  parentDir: z.string(), // remembered, else ~/Projects, else the most recent project's parent, else home
  home: z.string(),
  templates: z.array(TemplateInfoSchema),
  git: ToolStatusSchema.shape.git,
});
export type NewProjectDefaults = z.infer<typeof NewProjectDefaultsSchema>;

export const NewProjectCheckBodySchema = z.object({ parentDir: z.string().max(4096), name: z.string().max(1024) });
/** POST /api/projects/new/check — validation while typing (no side effects). */
export const NewProjectCheckSchema = z.object({
  path: z.string(), // the final folder (parentDir/name), ~ expanded
  ok: z.boolean(),
  name: z.object({ ok: z.boolean(), error: z.string().optional() }),
  parent: z.object({ exists: z.boolean(), isDir: z.boolean(), writable: z.boolean() }),
  target: z.object({ exists: z.boolean(), empty: z.boolean().optional() }),
  problems: z.array(z.string()), // human-readable, most important first
});
export type NewProjectCheck = z.infer<typeof NewProjectCheckSchema>;

export const CreateReportSchema = z.object({
  path: z.string(),
  template: z.string(),
  files: z.number(),
  scanned: z.object({ nodes: z.number(), edges: z.number() }).nullable(), // null = empty map (template "empty")
  git: z
    .object({ init: z.boolean(), branch: z.string().nullable(), commit: z.string().nullable(), warning: z.string().optional() })
    .nullable(),
  github: z
    .object({ command: z.array(z.string()), ran: z.boolean(), url: z.string().optional(), error: z.string().optional() })
    .nullable(),
  system: z.object({ root: z.string(), repoId: z.string().nullable(), error: z.string().optional() }).nullable(),
  warnings: z.array(z.string()),
});
export type CreateReport = z.infer<typeof CreateReportSchema>;
/** POST /api/projects/create answers the ProjectInfo (as before) plus `created`. */
export const CreateResultSchema = ProjectInfoSchema.extend({ created: CreateReportSchema.optional() });
export type CreateResult = z.infer<typeof CreateResultSchema>;

export const ReorderProjectsBodySchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200) });
export const ProjectTagsBodySchema = z.object({ id: z.string().min(1).max(64), tags: z.array(z.string().max(200)).max(32) });

// CONTRACTS §11: per-project scan options (persisted in state.json; defaults on).
export const ScanOptionsSchema = z.object({
  infra: z.boolean(), // infrastructure-as-code groups, links and "how it ships" workflows
});
export type ScanOptions = z.infer<typeof ScanOptionsSchema>;
export const ScanOptionsBodySchema = z.object({
  id: z.string().min(1).max(64).optional(), // default: the open project
  infra: z.boolean().optional(),
});
export const ScanOptionsResultSchema = z.object({ projectId: z.string(), options: ScanOptionsSchema });
export type ScanOptionsResult = z.infer<typeof ScanOptionsResultSchema>;

export const RecentChatSchema = ChatInfoSchema.extend({ projectName: z.string(), projectRoot: z.string() });
export type RecentChat = z.infer<typeof RecentChatSchema>;
export const RecentChatsSchema = z.object({ chats: z.array(RecentChatSchema) });
