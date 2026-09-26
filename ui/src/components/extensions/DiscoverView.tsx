// Discover: the curated catalog grouped by category (metadata only — nothing is downloaded to
// show it) plus the ways to add your own. Each card shows what it would run before adding.
import { Check, FolderOpen, GitBranch, Globe, Plus, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_LABEL, describeServer, groupByCategory, matchesQuery, type FeaturedExtension, type Load } from "@/lib/extensions";
import { Chip, KindMark, primaryButton, solidButton } from "./parts";
import type { SourceKind } from "./AddExtensionDialog";

function FeaturedCard({ entry, onAdd }: { entry: FeaturedExtension; onAdd: () => void }) {
  const runs = entry.runs;
  const env = [...(entry.env ?? []), ...(entry.optionalEnv ?? [])];
  return (
    <div className="card-warm flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <KindMark kind={entry.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="me-1 text-body font-medium text-foreground">{entry.name}</p>
            {runs !== undefined ? <Chip tone={runs.type === "stdio" ? "muted" : "info"}>{runs.type === "stdio" ? "Local" : "Remote"}</Chip> : null}
            {env.length > 0 ? <Chip tone="warn">Needs a secret</Chip> : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-ui-sm text-muted-foreground">{entry.description}</p>
        </div>
      </div>
      {entry.builtin !== undefined && entry.notes !== undefined ? <p className="text-label leading-relaxed text-muted-foreground">{entry.notes}</p> : null}
      {runs !== undefined ? (
        <p className="truncate rounded-md bg-surface-0 px-2 py-1 font-mono text-meta text-foreground/80 ring-1 ring-hairline" title={describeServer(runs.type === "stdio" ? { name: entry.id, transport: "stdio", command: runs.command, args: runs.args, env } : { name: entry.id, transport: runs.type, url: runs.url, env: [] })}>
          {runs.type === "stdio" ? `$ ${[runs.command, ...runs.args].join(" ")}` : runs.url}
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-2">
        {entry.suggestedFor !== undefined && entry.suggestedFor.length > 0 ? (
          <span className="truncate text-meta text-faint">Best with {entry.suggestedFor.map((a) => AGENT_LABEL[a]).join(", ")}</span>
        ) : (
          <span className="truncate text-meta text-faint">{entry.category}</span>
        )}
        <span className="flex-1" />
        {entry.builtin !== undefined ? (
          <span className="inline-flex items-center gap-1 text-label text-muted-foreground" title={entry.notes}>
            <Check className="size-3.5" /> Built into {AGENT_LABEL[entry.builtin]}
          </span>
        ) : entry.added === true ? (
          <span className="inline-flex items-center gap-1 text-label text-ok">
            <Check className="size-3.5" /> Added
          </span>
        ) : (
          <button type="button" className={solidButton} onClick={onAdd} aria-label={`Add ${entry.name}`}>
            <Plus className="size-3.5" /> Add
          </button>
        )}
      </div>
    </div>
  );
}

const CUSTOM: { source: SourceKind; icon: typeof Terminal; title: string; body: string }[] = [
  { source: "command", icon: Terminal, title: "MCP server command", body: "npx, uvx, docker or any executable — args, and secret names." },
  { source: "remote", icon: Globe, title: "Remote MCP server", body: "An https:// endpoint, OAuth or header secrets." },
  { source: "folder", icon: FolderOpen, title: "Local folder", body: "A skill (SKILL.md), Kiro power (POWER.md), plugin, or Markdown rules." },
  { source: "git", icon: GitBranch, title: "Git repository", body: "Cloned into Ruah's folder; pick a subfolder for one skill." },
];

export function DiscoverView({
  featured,
  query,
  onAddFeatured,
  onAddCustom,
}: {
  featured: Load<FeaturedExtension[]>;
  query: string;
  onAddFeatured: (entry: FeaturedExtension) => void;
  onAddCustom: (source?: SourceKind) => void;
}) {
  const list = featured.status === "ok" ? featured.data.filter((f) => matchesQuery(f, query)) : [];
  const groups = groupByCategory(list);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="heading text-title text-foreground">Your own</h2>
          <p className="mt-1 text-ui-sm text-muted-foreground">Anything you already use with Claude Code, Cursor or Kiro works here too.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {CUSTOM.map(({ source, icon: Icon, title, body }) => (
            <button
              key={title}
              type="button"
              onClick={() => onAddCustom(source)}
              className="group flex items-start gap-3 rounded-xl border border-dashed border-hairline px-3.5 py-3 text-start transition-colors hover:border-primary/40 hover:bg-surface-1"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              <span className="min-w-0">
                <span className="block text-ui font-medium text-foreground">{title}</span>
                <span className="block text-label text-muted-foreground">{body}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {featured.status === "loading" || featured.status === "idle" ? <p className="text-ui-sm text-muted-foreground">Loading the catalog…</p> : null}
      {featured.status === "error" ? <p className="text-ui-sm text-bad">{featured.message}</p> : null}
      {featured.status === "ok" && list.length === 0 ? <p className="text-ui-sm text-muted-foreground">Nothing in the catalog matches “{query}”.</p> : null}
      {groups.map((g) => (
        <section key={g.category} className="flex flex-col gap-3">
          <h2 className="eyebrow">{g.category}</h2>
          <div className={cn("grid gap-3", "sm:grid-cols-2")}>
            {g.items.map((entry) => (
              <FeaturedCard key={entry.id} entry={entry} onAdd={() => onAddFeatured(entry)} />
            ))}
          </div>
        </section>
      ))}
      {featured.status === "ok" ? (
        <div className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-1 px-4 py-3">
          <p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">Missing one? Add any MCP server by its command or URL.</p>
          <button type="button" className={primaryButton} onClick={() => onAddCustom("command")}>
            <Plus className="size-3.5" /> Add custom
          </button>
        </div>
      ) : null}
    </div>
  );
}
