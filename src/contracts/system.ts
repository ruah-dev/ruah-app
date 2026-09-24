import { z } from "zod";

// CONTRACTS.md §12 — multi-repo systems management: HTTP bodies. Result
// types (SystemStatus, RepoStatus, GithubRepo, StoredSuggestion, …) live in
// src/system/* and are re-exported here for the viewer's mirror.
export type { GitStatus, RepoStatus, SystemStatus } from "../system/status.js";
export type { GithubRepo } from "../system/github.js";
export type { RejectedSuggestionEntry, StoredSuggestion, SuggestionsFile } from "../system/suggestions-store.js";

const RepoIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "repo id must match ^[a-z0-9][a-z0-9-]*$ (<= 63 chars)");
const PathSchema = z.string().min(1).max(4096);

export const RepoInputSchema = z.object({ path: PathSchema, id: RepoIdSchema.optional() });

export const CreateSystemBodySchema = z.object({
  /** Folder for ruah.system.json (created when missing). An existing system there gets the repos added. */
  dir: PathSchema,
  name: z.string().min(1).max(200).optional(),
  repos: z.array(RepoInputSchema).max(100).default([]),
  /** Open the system as the current project afterwards (default true). */
  open: z.boolean().optional(),
});

export const AddRepoBodySchema = z
  .object({
    path: PathSchema.optional(),
    /** Clone `owner/name` with `gh repo clone` into parentDir (default: the system folder's parent), then add it. */
    github: z.object({ repo: z.string().min(3).max(200), parentDir: PathSchema.optional() }).optional(),
    id: RepoIdSchema.optional(),
  })
  .refine((b) => (b.path !== undefined) !== (b.github !== undefined), { message: "give either path or github" });

export const RepoIdBodySchema = z.object({ id: RepoIdSchema });
export const RenameRepoBodySchema = z.object({ id: RepoIdSchema, newId: RepoIdSchema });
export const CloneBodySchema = z.object({ repo: z.string().min(3).max(200), parentDir: PathSchema });
export const RunSuggestionsBodySchema = z.object({
  minConfidence: z.number().min(0).max(1).optional(),
  maxSuggestions: z.number().int().min(1).max(100).optional(),
});
export const SuggestionIdBodySchema = z.object({ id: z.string().min(1).max(64) });
