import { z } from "zod";
import { ActivityEventSchema, PermissionOptionSchema, ProjectInfoSchema } from "./ws.js";
import { GitStateSchema } from "./resume.js";
import { PreviewStateSchema } from "./preview.js";

// CONTRACTS.md §20.5 — GET /api/projects/overview: every recent project in one
// batched, cached answer for the Home page (cards sorted by what needs you).
// Computed by src/projects/overview.ts from $RUAH_HOME and the repos (git
// cached per repo), plus the daemon's live counts, pending permissions, preview
// states and each project's cached cloud health.

export const OverviewPermissionSchema = z.object({
  requestId: z.string(),
  turnId: z.string(),
  chatId: z.string().nullable(),
  title: z.string(), // the tool call's title ("Run pnpm migrate")
  options: z.array(PermissionOptionSchema), // answer with WS permission.response (routed to whichever agent asked, §13.1)
});
export type OverviewPermission = z.infer<typeof OverviewPermissionSchema>;

export const OverviewCloudSchema = z.object({
  inScope: z.number(), // resources in the project's §14 scope
  healthy: z.number(),
  degraded: z.number(),
  down: z.number(),
  deploying: z.number(),
  unhealthy: z.array(z.string()), // names, down first (≤ 5)
  syncedAt: z.string().nullable(),
});
export type OverviewCloud = z.infer<typeof OverviewCloudSchema>;

export const ProjectOverviewSchema = z.object({
  project: ProjectInfoSchema,
  current: z.boolean(), // the open project
  exists: z.boolean(), // always true: missing folders are left out, as in GET /api/projects (hidden, not forgotten)
  lastViewedAt: z.string().nullable(),
  lastChat: z
    .object({
      id: z.string(),
      title: z.string(),
      agentId: z.string(),
      updatedAt: z.string(),
      turnCount: z.number(),
      lastPrompt: z.string().nullable(), // ≤ 200 chars
      lastReply: z.string().nullable(), // ≤ 200 chars
    })
    .nullable(),
  since: z.object({
    from: z.string().nullable(),
    turnsFinished: z.number(),
    turnsFailed: z.number(),
    permissionsRequested: z.number(),
    filesTotal: z.number(),
    mapChanges: z.number(),
  }),
  /** The newest turn.finished / permission.requested / agent.error event of the project (any time). */
  lastEvent: ActivityEventSchema.nullable(),
  unread: z.number(),
  live: z.object({ running: z.number(), waitingPermission: z.number() }),
  permissions: z.array(OverviewPermissionSchema),
  git: GitStateSchema,
  cloud: OverviewCloudSchema.nullable(), // null: never synced / nothing in scope
  preview: z
    .object({ state: z.enum(["stopped", "starting", "running", "crashed"]), url: z.string().nullable(), exitCode: z.number().nullable() })
    .nullable(), // null: no preview this daemon run
  /** §23.9: product.json summary; null = none. Absent from older daemons. */
  product: z.object({ journeys: z.number(), questions: z.number(), gaps: z.number(), broken: z.number() }).nullable().optional(),
});
export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;

export const ProjectsOverviewSchema = z.object({
  at: z.string(),
  projects: z.array(ProjectOverviewSchema), // the recent list's order (pinned first, then most recent)
});
export type ProjectsOverview = z.infer<typeof ProjectsOverviewSchema>;
