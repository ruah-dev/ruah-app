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
export const CreateProjectBodySchema = z.object({
  parentDir: z.string().min(1),
  name: z.string().min(1),
  git: z.boolean().optional(),
});
export const PinProjectBodySchema = z.object({ id: z.string().min(1), pinned: z.boolean().optional() });
export const ForgetProjectBodySchema = z.object({ id: z.string().min(1) });

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
