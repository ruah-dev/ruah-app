// src/extensions/featured.ts — the curated catalog (featured.json, metadata
// only: nothing is downloaded or run to show it). Entries are validated once;
// a bad entry is dropped rather than breaking the Discover view.
import { z } from "zod";
import catalog from "./featured.json" with { type: "json" };
import {
  EXTENSION_AGENTS,
  EXTENSION_KINDS,
  EnvNameSchema,
  McpRunsSchema,
  type FeaturedExtension,
} from "../contracts/extensions.js";

const FeaturedSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
  kind: z.enum(EXTENSION_KINDS),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  homepage: z.string().optional(),
  runs: McpRunsSchema.optional(),
  env: z.array(EnvNameSchema).optional(),
  optionalEnv: z.array(EnvNameSchema).optional(),
  notes: z.string().optional(),
  suggestedFor: z.array(z.enum(EXTENSION_AGENTS)).optional(),
});

let cache: FeaturedExtension[] | undefined;

export function featuredCatalog(): FeaturedExtension[] {
  if (cache !== undefined) return cache;
  const list: FeaturedExtension[] = [];
  for (const raw of (catalog as { featured: unknown[] }).featured) {
    const parsed = FeaturedSchema.safeParse(raw);
    if (!parsed.success) continue;
    const f = parsed.data;
    list.push({
      id: f.id,
      kind: f.kind,
      name: f.name,
      description: f.description,
      category: f.category,
      ...(f.homepage !== undefined ? { homepage: f.homepage } : {}),
      ...(f.runs !== undefined ? { runs: f.runs } : {}),
      ...(f.env !== undefined ? { env: f.env } : {}),
      ...(f.optionalEnv !== undefined ? { optionalEnv: f.optionalEnv } : {}),
      ...(f.notes !== undefined ? { notes: f.notes } : {}),
      ...(f.suggestedFor !== undefined ? { suggestedFor: f.suggestedFor } : {}),
    });
  }
  cache = list;
  return list;
}

export function featuredEntry(id: string): FeaturedExtension | undefined {
  return featuredCatalog().find((f) => f.id === id);
}
