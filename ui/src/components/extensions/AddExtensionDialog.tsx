// Add an extension: a featured entry (pre-filled) or a custom one — a local folder, a git URL,
// an MCP server command, or a remote MCP URL. Adding never runs anything; the agents picked
// here are enabled right away (the user sees what it runs first).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  AGENT_LABEL,
  EXTENSION_AGENTS,
  splitArgs,
  splitNames,
  type AddRequest,
  type ExtensionAgent,
  type ExtensionScope,
  type ExtensionView,
  type ExtensionsApi,
  type FeaturedExtension,
  type WhatItRuns,
} from "@/lib/extensions";
import { KindMark, Segmented, WhatItRunsBlock, fieldClass, primaryButton, quietButton } from "./parts";

export type SourceKind = "folder" | "git" | "command" | "remote";

const SOURCE_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "folder", label: "Folder" },
  { value: "git", label: "Git" },
  { value: "command", label: "MCP command" },
  { value: "remote", label: "Remote MCP" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-label font-medium text-foreground">{label}</span>
      {children}
      {hint !== undefined ? <span className="block text-meta text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function AddExtensionDialog({
  open,
  onOpenChange,
  api,
  featured,
  hasProject,
  installedAgents,
  onAdded,
  initialSource = "command",
}: {
  /** The source form shown first for a custom extension. */
  initialSource?: SourceKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ExtensionsApi;
  /** Pre-filled from the catalog; null = custom. */
  featured: FeaturedExtension | null;
  hasProject: boolean;
  installedAgents: Partial<Record<ExtensionAgent, boolean>>;
  onAdded: (view: ExtensionView) => void;
}) {
  const [source, setSource] = useState<SourceKind>("command");
  const [scope, setScope] = useState<ExtensionScope>("global");
  const [agents, setAgents] = useState<ExtensionAgent[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envNames, setEnvNames] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [headers, setHeaders] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens for a (different) entry.
  useEffect(() => {
    if (!open) return;
    setAgents(featured?.suggestedFor ?? []);
    setScope("global");
    setError(null);
    setBusy(false);
    if (featured === null) {
      setSource(initialSource);
      setName("");
      setPath("");
      setGitUrl("");
      setGitRef("");
      setGitSubdir("");
      setCommand("");
      setArgs("");
      setEnvNames("");
      setUrl("");
      setHeaders("");
    }
  }, [open, featured, initialSource]);

  const what: WhatItRuns | null = useMemo(() => {
    if (featured !== null) {
      const runs = featured.runs;
      if (runs === undefined) return null;
      const env = [...(featured.env ?? []), ...(featured.optionalEnv ?? [])];
      return {
        servers: [
          runs.type === "stdio"
            ? { name: featured.id, transport: "stdio", command: runs.command, args: runs.args, env }
            : { name: featured.id, transport: runs.type, url: runs.url, env: [], ...(runs.headers !== undefined ? { headers: runs.headers } : {}) },
        ],
        hooks: [],
        files: [],
        launcher: runs.type === "stdio" && env.length > 0,
      };
    }
    if (source === "command" && command.trim().length > 0) {
      const env = splitNames(envNames);
      return { servers: [{ name: name.trim() || "server", transport: "stdio", command: command.trim(), args: splitArgs(args), env }], hooks: [], files: [], launcher: env.length > 0 };
    }
    if (source === "remote" && url.trim().length > 0) {
      const h = splitNames(headers);
      return { servers: [{ name: name.trim() || "server", transport, url: url.trim(), env: [], ...(h.length > 0 ? { headers: h } : {}) }], hooks: [], files: [], launcher: false };
    }
    return null;
  }, [featured, source, command, args, envNames, url, transport, headers, name]);

  const request = (): AddRequest | string => {
    const common = { scope, ...(agents.length > 0 ? { enableFor: agents } : {}), ...(name.trim().length > 0 ? { name: name.trim() } : {}) };
    if (featured !== null) return { scope, source: { type: "featured", id: featured.id }, ...(agents.length > 0 ? { enableFor: agents } : {}) };
    switch (source) {
      case "folder":
        if (!path.trim().startsWith("/")) return "Enter the folder's absolute path (e.g. /Users/you/skills/review).";
        return { ...common, source: { type: "local", path: path.trim() } };
      case "git":
        if (gitUrl.trim().length === 0) return "Enter a git URL (https://… or git@host:owner/repo).";
        return {
          ...common,
          source: {
            type: "git",
            url: gitUrl.trim(),
            ...(gitRef.trim().length > 0 ? { ref: gitRef.trim() } : {}),
            ...(gitSubdir.trim().length > 0 ? { subdir: gitSubdir.trim() } : {}),
          },
        };
      case "command": {
        if (command.trim().length === 0) return "Enter the command that starts the server (e.g. npx).";
        if (/\s/.test(command.trim())) return "Put only the executable in Command and its arguments in Arguments.";
        const env = splitNames(envNames);
        return { ...common, source: { type: "inline", runs: { type: "stdio", command: command.trim(), args: splitArgs(args) }, ...(env.length > 0 ? { env } : {}) } };
      }
      case "remote": {
        if (url.trim().length === 0) return "Enter the server URL.";
        const h = splitNames(headers);
        return { ...common, source: { type: "inline", runs: { type: transport, url: url.trim(), ...(h.length > 0 ? { headers: h } : {}) } } };
      }
    }
  };

  const submit = async () => {
    const req = request();
    if (typeof req === "string") {
      setError(req);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await api.add(req);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    onAdded(r.data.extension);
    onOpenChange(false);
  };

  const toggleAgent = (agent: ExtensionAgent) => setAgents((prev) => (prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {featured !== null ? <KindMark kind={featured.kind} className="size-7" /> : null}
            {featured !== null ? `Add ${featured.name}` : "Add an extension"}
          </DialogTitle>
          <DialogDescription>
            {featured !== null
              ? featured.description
              : "A skill, plugin, Kiro power or rule folder, a git repository, or an MCP server. Adding runs nothing."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {featured === null ? (
            <>
              <Segmented label="Source" value={source} options={SOURCE_OPTIONS} onChange={setSource} className="w-fit" />
              {source === "folder" ? (
                <Field label="Folder" hint="A folder with SKILL.md, POWER.md, a plugin manifest (.claude-plugin/plugin.json) or .mcp.json — or a Markdown rule file.">
                  <input className={cn(fieldClass, "font-mono")} value={path} onChange={(e) => setPath(e.currentTarget.value)} placeholder="/Users/you/skills/code-review" spellCheck={false} />
                </Field>
              ) : null}
              {source === "git" ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                  <Field label="Repository" hint="Cloned (depth 1, no hooks) into Ruah's folder. Nothing in it runs.">
                    <input className={cn(fieldClass, "font-mono")} value={gitUrl} onChange={(e) => setGitUrl(e.currentTarget.value)} placeholder="https://github.com/owner/skills" spellCheck={false} />
                  </Field>
                  <Field label="Branch / tag">
                    <input className={cn(fieldClass, "font-mono")} value={gitRef} onChange={(e) => setGitRef(e.currentTarget.value)} placeholder="default" spellCheck={false} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Folder inside the repository" hint="Optional, e.g. skills/pdf">
                      <input className={cn(fieldClass, "font-mono")} value={gitSubdir} onChange={(e) => setGitSubdir(e.currentTarget.value)} placeholder="(repository root)" spellCheck={false} />
                    </Field>
                  </div>
                </div>
              ) : null}
              {source === "command" ? (
                <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                  <Field label="Command">
                    <input className={cn(fieldClass, "font-mono")} value={command} onChange={(e) => setCommand(e.currentTarget.value)} placeholder="npx" spellCheck={false} />
                  </Field>
                  <Field label="Arguments" hint="${project} is the project folder, ${home} your home.">
                    <input className={cn(fieldClass, "font-mono")} value={args} onChange={(e) => setArgs(e.currentTarget.value)} placeholder="-y @playwright/mcp@latest" spellCheck={false} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Secrets / env var names" hint="Names only. You set the values afterwards; they go to the macOS Keychain.">
                      <input className={cn(fieldClass, "font-mono")} value={envNames} onChange={(e) => setEnvNames(e.currentTarget.value)} placeholder="API_TOKEN, OTHER_KEY" spellCheck={false} />
                    </Field>
                  </div>
                </div>
              ) : null}
              {source === "remote" ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                  <Field label="URL" hint="https:// (http:// only for localhost).">
                    <input className={cn(fieldClass, "font-mono")} value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
                  </Field>
                  <Field label="Transport">
                    <Segmented label="Transport" value={transport} options={[{ value: "http", label: "HTTP" }, { value: "sse", label: "SSE" }]} onChange={setTransport} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Secret headers" hint="Header names whose values you store in the Keychain (e.g. Authorization). Leave empty for OAuth servers.">
                      <input className={cn(fieldClass, "font-mono")} value={headers} onChange={(e) => setHeaders(e.currentTarget.value)} placeholder="Authorization" spellCheck={false} />
                    </Field>
                  </div>
                </div>
              ) : null}
              <Field label="Name" hint="Optional; the id is derived from it.">
                <input className={fieldClass} value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="(from the folder, repository or command)" />
              </Field>
            </>
          ) : null}

          {what !== null ? (
            <div className="space-y-1.5">
              <p className="eyebrow">What it will run</p>
              <WhatItRunsBlock what={what} />
            </div>
          ) : featured === null && (source === "folder" || source === "git") ? (
            <p className="text-label text-muted-foreground">
              What it runs is read from the folder after it is added. If it runs commands (MCP servers, hooks), its card asks you to approve them before any agent gets it.
            </p>
          ) : null}
          {featured?.notes !== undefined ? <p className="text-label leading-relaxed text-muted-foreground">{featured.notes}</p> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-label font-medium text-foreground">Where</p>
              <Segmented
                label="Scope"
                value={scope}
                options={[
                  { value: "global", label: "All projects", title: "$RUAH_HOME/extensions.json on this machine" },
                  ...(hasProject ? [{ value: "project" as const, label: "This project", title: ".ruah/extensions.json in the repo (committable, no secrets)" }] : []),
                ]}
                onChange={setScope}
                className="w-fit"
              />
              {scope === "project" && featured === null && source === "folder" ? (
                <p className="text-meta text-muted-foreground">Only a folder inside this repo: the committed file stores its path relative to the repo.</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <p className="text-label font-medium text-foreground">Enable for</p>
              <div className="flex flex-wrap gap-1.5">
                {EXTENSION_AGENTS.map((agent) => {
                  const on = agents.includes(agent);
                  return (
                    <button
                      key={agent}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleAgent(agent)}
                      className={cn(
                        "h-6 rounded-md border px-2 text-label transition-colors",
                        on ? "border-ai/40 bg-ai/10 text-foreground" : "border-hairline text-muted-foreground hover:text-foreground",
                        installedAgents[agent] === false && "opacity-60",
                      )}
                    >
                      {AGENT_LABEL[agent]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          {error !== null ? <p className="text-ui-sm text-bad">{error}</p> : null}
        </div>

        <DialogFooter>
          <button type="button" className={quietButton} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {agents.length > 0 ? `Add and enable for ${agents.length}` : "Add"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
