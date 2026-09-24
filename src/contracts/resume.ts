import { z } from "zod";
import { ActivityEventSchema, ProjectKindSchema } from "./ws.js";

// CONTRACTS.md §13.4 — "where you left off": GET /api/projects/:id/resume and
// `ruah app resume --json`. Computed by src/resume/* from $RUAH_HOME and the
// repo, with or without a daemon.

export const GitStateSchema = z.union([
  z.object({
    available: z.literal(true),
    branch: z.string().nullable(), // null = detached HEAD
    head: z.string().nullable(), // short commit id (null in an empty repo)
    upstream: z.string().nullable(),
    ahead: z.number().nullable(), // null without an upstream
    behind: z.number().nullable(),
    dirty: z.number(), // changed + untracked paths
    dirtyPaths: z.array(z.string()), // the first N (default 5)
    lastCommit: z
      .object({ hash: z.string(), subject: z.string(), author: z.string(), at: z.string() })
      .nullable(),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type GitState = z.infer<typeof GitStateSchema>;

export const RuahTaskSummarySchema = z.object({
  name: z.string(),
  status: z.string(), // created | in-progress | failed | conflict (done / merged / cancelled are left out)
  executor: z.string().optional(),
  files: z.array(z.string()).optional(),
});
export type RuahTaskSummary = z.infer<typeof RuahTaskSummarySchema>;

export const RuahResumeSchema = z.union([
  z.object({ initialized: z.literal(false) }),
  z.object({ initialized: z.literal(true), tasks: z.array(RuahTaskSummarySchema), error: z.string().optional() }),
]);
export type RuahResume = z.infer<typeof RuahResumeSchema>;

export const ResumeInfoSchema = z.object({
  project: z.object({ id: z.string(), name: z.string(), root: z.string(), kind: ProjectKindSchema, lastOpenedAt: z.string().nullable() }),
  /** When the user last left the project (switched away / daemon stopped); null = never recorded. */
  lastViewedAt: z.string().nullable(),
  lastChat: z
    .object({
      id: z.string(),
      title: z.string(),
      agentId: z.string(),
      updatedAt: z.string(),
      turnCount: z.number(),
      /** Last prompt and the start of the agent's last answer (each ≤ 200 chars). */
      lastPrompt: z.string().nullable(),
      lastReply: z.string().nullable(),
    })
    .nullable(),
  lastFocus: z.object({ nodeId: z.string(), name: z.string(), at: z.string().optional() }).nullable(),
  /** Agent activity since lastViewedAt (everything logged when it is null). */
  since: z.object({
    from: z.string().nullable(),
    turnsFinished: z.number(),
    turnsFailed: z.number(),
    permissionsRequested: z.number(),
    files: z.array(z.string()), // at most 20, most recent first
    filesTotal: z.number(),
    mapChanges: z.number(),
    events: z.array(ActivityEventSchema), // at most 20, newest last
  }),
  unread: z.number(),
  /** Live counts; present only when a running daemon answered. */
  live: z.object({ running: z.number(), waitingPermission: z.number() }).optional(),
  git: GitStateSchema,
  ruah: RuahResumeSchema,
  /** §13.5 view state saved by the viewer, or null. */
  view: z.record(z.string(), z.unknown()).nullable(),
  /** Ranking for "all projects" (higher = needs attention first); see §13.4. */
  attention: z.number(),
});
export type ResumeInfo = z.infer<typeof ResumeInfoSchema>;
