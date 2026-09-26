// Create an issue for an element: provider, project key (Jira) or repo (GitHub), title and body
// prefilled from the element, then an explicit review step before POST /api/work/create — the
// issue is real and visible to the team, so nothing is created without that second click.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ExternalLink, Loader2 } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import type { IntegrationInfo, WorkItem } from "@/lib/contracts";
import { createWorkItem, elementSummary } from "@/lib/integrations";
import { useWorkspace } from "@/lib/workspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProviderGlyph, primaryButton, quietButton } from "@/components/integrations/common";

const TARGET_KEY = "ruah.work.target.";

function readTarget(provider: string): string {
  try {
    return window.localStorage.getItem(TARGET_KEY + provider) ?? "";
  } catch {
    return "";
  }
}
function writeTarget(provider: string, value: string) {
  try {
    window.localStorage.setItem(TARGET_KEY + provider, value);
  } catch {
    /* storage unavailable */
  }
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function CreateIssueDialog({
  open,
  onOpenChange,
  node,
  providers,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: DiagramNode;
  /** Connected work integrations (Jira, GitHub). */
  providers: IntegrationInfo[];
  onCreated: (item: WorkItem) => void;
}) {
  const { architecture } = useWorkspace();
  const [step, setStep] = useState<"form" | "confirm" | "done">("form");
  const [provider, setProvider] = useState(providers[0]?.id ?? "jira");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WorkItem | null>(null);

  // Fresh prefill every time the dialog opens for an element.
  useEffect(() => {
    if (!open) return;
    const p = providers[0]?.id ?? "jira";
    setStep("form");
    setProvider(p);
    setTarget(readTarget(p));
    setTitle(`${node.label}: `);
    setBody(elementSummary(node, architecture));
    setError(null);
    setCreated(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node.id]);

  const isJira = provider === "jira";
  const info = providers.find((p) => p.id === provider);
  const where = isJira
    ? `${target || "…"}${info?.accounts?.[0] ? ` on ${info.accounts[0].label}` : ""}`
    : target || "…";
  const targetValid = isJira ? JIRA_KEY.test(target) : GH_REPO.test(target);
  const titleText = title.trim();
  const valid = targetValid && titleText.length > 0 && titleText !== `${node.label}:`;

  const summary = useMemo(() => body.split("\n").slice(0, 14).join("\n"), [body]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    writeTarget(provider, target);
    const res = await createWorkItem({
      provider,
      title: titleText,
      body,
      nodeId: node.id,
      ...(isJira ? { projectKey: target } : { repo: target }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setCreated(res.data);
    setStep("done");
    onCreated(res.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5 rounded-xl p-5">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-title">
            {step === "confirm" ? "Create this issue?" : step === "done" ? "Issue created" : "Create issue"}
          </DialogTitle>
          <DialogDescription className="text-ui-sm">
            {step === "form"
              ? `For ${node.label}. It is linked to the element once created.`
              : step === "confirm"
                ? `This creates a real ${info?.name ?? provider} issue in ${where}, visible to your team.`
                : `Linked to ${node.label}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 max-sm:grid-cols-1">
              <div className="space-y-1.5">
                <Label className="text-ui-sm font-normal text-muted-foreground">Tracker</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    setProvider(v);
                    setTarget(readTarget(v));
                  }}
                >
                  <SelectTrigger className="h-8 text-ui md:text-ui">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-ui">
                        <span className="flex items-center gap-2">
                          <ProviderGlyph id={p.id} /> {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="issue-target" className="text-ui-sm font-normal text-muted-foreground">
                  {isJira ? "Project key" : "Repository"}
                </Label>
                <Input
                  id="issue-target"
                  value={target}
                  onChange={(e) => setTarget(isJira ? e.target.value.toUpperCase() : e.target.value)}
                  placeholder={isJira ? "PLAT" : "owner/repo"}
                  spellCheck={false}
                  className="h-8 font-mono text-ui md:text-ui"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-title" className="text-ui-sm font-normal text-muted-foreground">
                Title
              </Label>
              <Input
                id="issue-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 text-ui md:text-ui"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-body" className="text-ui-sm font-normal text-muted-foreground">
                Description <span className="text-faint">· Markdown, prefilled from the element</span>
              </Label>
              <Textarea
                id="issue-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={9}
                className="max-h-72 resize-y font-mono text-label leading-relaxed md:text-label"
              />
            </div>
            {target && !targetValid ? (
              <p className="text-label text-warn">
                {isJira ? "Project keys are upper-case letters and digits, e.g. PLAT." : "Use owner/repo."}
              </p>
            ) : null}
          </div>
        ) : step === "confirm" ? (
          <div className="space-y-3 rounded-lg border border-hairline bg-surface-1 p-3.5">
            <div className="flex items-center gap-2 text-label text-muted-foreground">
              <ProviderGlyph id={provider} />
              <span className="font-mono">{where}</span>
            </div>
            <p className="text-title-sm font-medium text-foreground">{titleText}</p>
            <pre className="max-h-48 overflow-y-auto font-mono text-meta leading-relaxed whitespace-pre-wrap text-muted-foreground md:text-meta">
              {summary}
              {body.split("\n").length > 14 ? "\n…" : ""}
            </pre>
          </div>
        ) : created ? (
          <a
            href={created.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-1 px-3.5 py-3 transition-colors hover:bg-surface-2"
          >
            <Check className="size-4 text-ok" />
            <span className="font-mono text-ui-sm text-muted-foreground">{created.id}</span>
            <span className="min-w-0 flex-1 truncate text-ui text-foreground">{created.title}</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </a>
        ) : null}

        {error ? <p className="text-ui-sm text-bad">{error}</p> : null}

        <DialogFooter className="gap-2 sm:gap-1">
          {step === "form" ? (
            <>
              <button type="button" className={quietButton} onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="button" className={primaryButton} disabled={!valid} onClick={() => setStep("confirm")}>
                Review
              </button>
            </>
          ) : step === "confirm" ? (
            <>
              <button type="button" className={quietButton} disabled={busy} onClick={() => setStep("form")}>
                <ArrowLeft className="size-3.5" /> Back
              </button>
              <button type="button" className={primaryButton} disabled={busy} onClick={() => void submit()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Create issue
              </button>
            </>
          ) : (
            <button type="button" className={primaryButton} onClick={() => onOpenChange(false)}>
              Done
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
