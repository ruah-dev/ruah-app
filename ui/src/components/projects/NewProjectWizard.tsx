// New project wizard (§20.1, replaces the one-form dialog): 1 name + location (the remembered
// folder, the final path, live checks: exists / not empty / permissions), 2 starting point (Empty
// or one of the offline templates), 3 options (git init + first commit, GitHub with the exact
// `gh repo create` command — never run without its switch —, add to a system, ask the agent to set
// it up). Then the daemon scans + opens it and the shell shows first-run hints. Keyboard-first:
// Enter = next / create, ⌘Enter = create now, Alt+← = back, arrows pick a template. Nothing is
// ever overwritten: the folder must not exist (the daemon claims it with an exclusive mkdir).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  CircleAlert,
  CloudCog,
  FileText,
  FolderOpen,
  GitBranch,
  Github,
  Globe,
  Layers,
  Loader2,
  Server,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { GithubToolStatus, NewProjectCheck, NewProjectDefaults, TemplateInfo } from "@/lib/contracts";
import { checkNewProject, createProject, fetchGithubStatus, fetchNewProjectDefaults } from "@/lib/daemon";
import {
  WIZARD_STEPS,
  canAdvance,
  checkKey,
  createInput,
  createsPath,
  currentCheck,
  defaultPrompt,
  ghCommand,
  initialWizard,
  joinPath,
  locationNote,
  nameProblem,
  pathMessage,
  prettyHome,
  repoNameFor,
  type WizardState,
  type WizardStep,
} from "@/lib/new-project";
import { prettyPath } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { canManageProjects } from "./useProjectActions";
import { queueFirstPrompt, setFirstRunHints } from "./firstRun";

const fieldClass = "h-9 rounded-lg border-hairline bg-surface-2 text-ui shadow-none focus-visible:ring-1 md:text-ui";

const TEMPLATE_ICONS: Record<string, typeof FileText> = {
  empty: FileText,
  "web-vite-react": AppWindow,
  "node-api-ts": Server,
  "static-site": Globe,
  "pnpm-monorepo": Boxes,
  "infra-terraform": CloudCog,
};

function StepDots({ step, onPick }: { step: WizardStep; onPick: (s: WizardStep) => void }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Steps">
      {WIZARD_STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden className="h-px w-4 bg-hairline" /> : null}
            <button
              type="button"
              disabled={i > step}
              onClick={() => onPick(i as WizardStep)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-pill px-2 text-[11.5px] transition-colors disabled:cursor-default",
                active ? "bg-primary/12 font-medium text-brand" : done ? "text-foreground hover:bg-accent" : "text-faint",
              )}
            >
              <span
                className={cn(
                  "grid size-4 place-items-center rounded-full text-[10px] tabular-nums",
                  active ? "bg-primary text-primary-foreground" : done ? "bg-ok/20 text-ok" : "bg-surface-3 text-muted-foreground",
                )}
              >
                {done ? <Check className="size-2.5" /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Tone({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) {
  const Icon = tone === "ok" ? Check : tone === "bad" ? CircleAlert : tone === "warn" ? TriangleAlert : Loader2;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-meta leading-relaxed",
        tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("mt-px size-3.5 shrink-0", tone === "muted" && "animate-spin motion-reduce:animate-none")} />
      <span>{children}</span>
    </p>
  );
}

function OptionRow({
  icon: Icon,
  title,
  hint,
  checked,
  onChange,
  disabled,
  children,
  id,
}: {
  icon: typeof GitBranch;
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  id: string;
}) {
  return (
    <div className={cn("rounded-xl border border-hairline bg-surface-1 transition-colors", checked && !disabled && "border-primary/30")}>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer", disabled && "cursor-not-allowed opacity-60")}>
          <span className="block text-ui text-foreground">{title}</span>
          {hint ? <span className="mt-0.5 block text-meta leading-relaxed text-muted-foreground">{hint}</span> : null}
        </label>
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-1" />
      </div>
      {children ? <div className="border-t border-hairline px-3.5 py-3">{children}</div> : null}
    </div>
  );
}

function TemplateCard({ t, selected, onSelect, onOpen }: { t: TemplateInfo; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const Icon = TEMPLATE_ICONS[t.id] ?? Layers;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-template={t.id}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group/t flex min-h-[7.5rem] w-full flex-col gap-2 rounded-xl border p-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary/50 bg-primary/[0.06]" : "border-hairline bg-surface-1 hover:bg-surface-2",
      )}
    >
      <span className="flex items-center gap-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", selected ? "bg-primary/15 text-brand" : "bg-surface-2 text-muted-foreground")}>
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{t.name}</span>
        {selected ? <Check className="size-3.5 shrink-0 text-brand" /> : null}
      </span>
      <span className="line-clamp-2 text-meta leading-relaxed text-muted-foreground">{t.description}</span>
      <span className="mt-auto flex flex-wrap gap-1">
        {t.files.slice(0, 6).map((f) => (
          <span key={f} className="rounded bg-surface-3 px-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
            {f}
          </span>
        ))}
        {t.files.length > 6 ? <span className="px-1 font-mono text-[10.5px] leading-4 text-faint">+{t.files.length - 6}</span> : null}
      </span>
    </button>
  );
}

export function NewProjectWizard() {
  const wb = useWorkbench();
  const router = useRouter();
  const { daemon } = useWorkspace();
  const connected = canManageProjects(daemon);
  const open = wb.newProjectOpen;

  const [step, setStep] = useState<WizardStep>(0);
  const [state, setState] = useState<WizardState>(() => initialWizard(""));
  const [defaults, setDefaults] = useState<NewProjectDefaults | null>(null);
  // The last check, with the input it answers: during the debounce it is for an older input and
  // doesn't count (no "Available" or Create for a path that wasn't checked).
  const [checked, setChecked] = useState<{ key: string; check: NewProjectCheck } | null>(null);
  const check = currentCheck(checked, state);
  const [gh, setGh] = useState<GithubToolStatus | "loading" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptEdited, setPromptEdited] = useState(false);
  const typedParent = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const templatesRef = useRef<HTMLDivElement | null>(null);

  const patch = useCallback((p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), []);

  // Opened: fresh state, the daemon's proposed folder and templates.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setState(initialWizard(defaults?.parentDir ?? ""));
    setChecked(null);
    setError(null);
    setGh(null);
    setPromptEdited(false);
    typedParent.current = false;
    if (!connected) return;
    let live = true;
    fetchNewProjectDefaults()
      .then((d) => {
        if (!live) return;
        setDefaults(d);
        if (!typedParent.current) setState((s) => ({ ...s, parentDir: prettyHome(d.parentDir, d.home) }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connected]);

  // Live checks while typing (debounced; no side effects on the daemon).
  useEffect(() => {
    if (!open || !connected) return;
    const name = state.name.trim();
    const parent = state.parentDir.trim();
    if (!name || !parent || nameProblem(name)) return;
    const key = checkKey({ parentDir: parent, name });
    let live = true;
    const t = setTimeout(() => {
      checkNewProject(parent, name)
        .then((c) => live && setChecked({ key, check: c }))
        .catch(() => live && setChecked(null));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, connected, state.name, state.parentDir]);

  // The GitHub option asks gh only when the options step shows (it may take a moment).
  useEffect(() => {
    if (!open || step !== 2 || gh !== null || !connected) return;
    setGh("loading");
    fetchGithubStatus()
      .then(setGh)
      .catch(() => setGh({ installed: false, loggedIn: false }));
  }, [open, step, gh, connected]);

  const templates = defaults?.templates ?? [];
  const template = templates.find((t) => t.id === state.template);
  const systems = useMemo(() => daemon.recentProjects.filter((p) => p.kind === "system"), [daemon.recentProjects]);

  // The suggested prompt follows the template until it is edited.
  useEffect(() => {
    if (!promptEdited) patch({ prompt: defaultPrompt(template, state.name) });
  }, [template, state.name, promptEdited, patch]);

  // Focus: the name on step 1, the selected template on step 2.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      if (step === 0) nameRef.current?.focus();
      if (step === 1) templatesRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, step]);

  const finalPath = createsPath(check, state, defaults?.home);
  const note = locationNote(defaults, state.parentDir);
  // --push only when the first commit will be made (the daemon skips it without a git identity).
  const willCommit = state.commit && defaults?.git.identity !== false;
  const typedProblem = nameProblem(state.name);
  const location = typedProblem ? { tone: "bad" as const, text: typedProblem } : state.name.trim() ? pathMessage(check, state) : null;
  const stepOk = canAdvance(step, state, check);
  const readyToCreate = connected && canAdvance(0, state, check) && canAdvance(2, state, check) && !busy;

  const submit = async () => {
    if (!readyToCreate) return;
    setBusy(true);
    setError(null);
    const input = createInput(state);
    try {
      wb.setLauncherOpen(false);
      const result = await createProject(input);
      wb.setNewProjectOpen(false);
      const report = result.created;
      setFirstRunHints({
        projectId: result.id,
        template: state.template,
        templateName: template?.name ?? state.template,
        ...(template?.run ? { run: template.run } : {}),
        scanned: report ? report.scanned !== null : state.template !== "empty",
        askedAgent: state.askAgent && !!state.prompt.trim(),
        gitCommit: report?.git?.commit ?? null,
        ...(report?.github?.url ? { githubUrl: report.github.url } : {}),
      });
      if (state.askAgent && state.prompt.trim()) queueFirstPrompt(result.id, state.prompt.trim());
      void router.navigate({ to: "/map" });
      const bits = [
        template?.name ?? "Empty",
        report?.scanned ? `${report.scanned.nodes} elements on the map` : "an empty map",
        report?.git?.commit ? `git ${report.git.branch ?? ""} @ ${report.git.commit}`.replace("  ", " ") : report?.git ? "git (no commit)" : "",
        report?.github?.url ? "on GitHub" : "",
      ].filter(Boolean);
      const bridge = typeof window !== "undefined" ? window.ruah : undefined;
      // Top centre (like the update toast): the new project opens with the agent panel, and a
      // bottom-right toast covered the composer's Send button for seconds.
      toast.success(`Created ${result.name}`, {
        position: "top-center",
        description: bits.join(" · "),
        ...(bridge ? { action: { label: "Reveal", onClick: () => bridge.revealInFinder(result.root) } } : {}),
      });
      for (const w of report?.warnings ?? []) toast.warning(w, { position: "top-center" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!stepOk) return;
    if (step < 2) setStep((s) => (s + 1) as WizardStep);
    else void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "ArrowLeft" && e.altKey && step > 0) {
      e.preventDefault();
      setStep((s) => (s - 1) as WizardStep);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && target.tagName !== "TEXTAREA" && target.getAttribute("role") !== "switch" && !(target.tagName === "BUTTON" && target.getAttribute("role") !== "radio")) {
      e.preventDefault();
      next();
    }
  };

  const moveTemplate = (delta: number) => {
    if (!templates.length) return;
    const i = Math.max(0, templates.findIndex((t) => t.id === state.template));
    const nextT = templates[(i + delta + templates.length) % templates.length]!;
    patch({ template: nextT.id });
    requestAnimationFrame(() => templatesRef.current?.querySelector<HTMLElement>(`[data-template="${nextT.id}"]`)?.focus());
  };

  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  const ghReady = gh !== null && gh !== "loading" && gh.installed && gh.loggedIn;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && wb.setNewProjectOpen(v)}>
      <DialogContent
        onKeyDown={onKeyDown}
        className="flex max-h-[min(92vh,760px)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 rounded-2xl border-hairline bg-popover p-0"
      >
        <div className="space-y-3 border-b border-hairline px-5 pt-5 pb-3.5">
          <div className="pe-8">
            <DialogTitle className="text-title font-semibold">New project</DialogTitle>
            <DialogDescription className="mt-1 text-ui-sm">
              A new folder with a starting point, a map and git. Nothing existing is ever overwritten.
            </DialogDescription>
          </div>
          <StepDots step={step} onPick={setStep} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 0 ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="np-name" className="text-label text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="np-name"
                  ref={nameRef}
                  value={state.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="payments-platform"
                  spellCheck={false}
                  autoComplete="off"
                  className={fieldClass}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-parent" className="text-label text-muted-foreground">
                  Location
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="np-parent"
                    value={state.parentDir}
                    onChange={(e) => {
                      typedParent.current = true;
                      patch({ parentDir: e.target.value, createParent: false });
                    }}
                    placeholder="~/Projects"
                    spellCheck={false}
                    autoComplete="off"
                    className={cn(fieldClass, "font-mono")}
                  />
                  {bridge ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 gap-1.5 rounded-lg border-hairline bg-surface-2 text-ui-sm shadow-none"
                      onClick={async () => {
                        const p = await bridge.pickFolder({ title: "Where to create the project" }).catch(() => null);
                        if (p) {
                          typedParent.current = true;
                          patch({ parentDir: defaults ? prettyHome(p, defaults.home) : p, createParent: false });
                        }
                      }}
                    >
                      <FolderOpen className="size-3.5" />
                      Choose…
                    </Button>
                  ) : null}
                </div>
                {note ? <p className="text-meta text-faint">{note}</p> : null}
              </div>
              <div className="space-y-1.5 rounded-xl border border-hairline bg-surface-1 px-3.5 py-3">
                <p className="text-label text-muted-foreground">Creates</p>
                {/* Long paths keep their end (the new folder) in view. */}
                <p className="truncate text-left font-mono text-ui text-foreground [direction:rtl]" title={check?.path ?? finalPath}>
                  <bdi>{state.name.trim() ? finalPath : <span className="text-faint">{joinPath(state.parentDir || "~/Projects", "<name>")}</span>}</bdi>
                </p>
                {location ? <Tone tone={location.tone}>{location.text}</Tone> : null}
                {check && !check.parent.exists && check.parent.writable && !typedProblem ? (
                  <label className="flex cursor-pointer items-center gap-2 pt-1 text-ui-sm">
                    <Checkbox
                      checked={state.createParent}
                      onCheckedChange={(v) => patch({ createParent: v === true })}
                      className="size-4 rounded-[4px]"
                    />
                    Create{" "}
                    <span className="font-mono">
                      {check.parent.path && defaults ? prettyHome(check.parent.path, defaults.home) : (check.parent.path ?? state.parentDir.trim())}
                    </span>{" "}
                    too
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div
              ref={templatesRef}
              role="radiogroup"
              aria-label="Starting point"
              className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  moveTemplate(e.key === "ArrowDown" ? 2 : 1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  if (e.altKey) return;
                  e.preventDefault();
                  moveTemplate(e.key === "ArrowUp" ? -2 : -1);
                }
              }}
            >
              {templates.length === 0 ? (
                <p className="col-span-2 flex items-center gap-2 text-ui-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading templates…
                </p>
              ) : (
                templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    t={t}
                    selected={t.id === state.template}
                    onSelect={() => patch({ template: t.id })}
                    onOpen={() => {
                      patch({ template: t.id });
                      setStep(2);
                    }}
                  />
                ))
              )}
              {template?.run ? (
                <p className="col-span-2 text-meta text-muted-foreground max-sm:col-span-1">
                  Runs with <code className="rounded bg-surface-3 px-1 font-mono text-[11px]">{template.run}</code> — Ruah writes the files; it never installs
                  or downloads anything.
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-2.5">
              <OptionRow
                id="np-git"
                icon={GitBranch}
                title="Initialize git"
                hint={
                  defaults && !defaults.git.installed
                    ? "git isn't installed on this machine."
                    : "git init on the default branch (your init.defaultBranch, else main)."
                }
                checked={state.git && defaults?.git.installed !== false}
                disabled={defaults?.git.installed === false}
                onChange={(v) => patch({ git: v, ...(v ? {} : { github: false }) })}
              >
                {state.git && defaults?.git.installed !== false ? (
                  <div className="space-y-1.5">
                    <label className="flex cursor-pointer items-center gap-2 text-ui-sm">
                      <Checkbox checked={state.commit} onCheckedChange={(v) => patch({ commit: v === true })} className="size-4 rounded-[4px]" />
                      Commit the starting files as the first commit
                    </label>
                    {state.commit && defaults && !defaults.git.identity ? (
                      <Tone tone="warn">git has no user.name / user.email yet: the folder is created, the commit is skipped.</Tone>
                    ) : null}
                  </div>
                ) : null}
              </OptionRow>

              <OptionRow
                id="np-gh"
                icon={Github}
                title="Create a GitHub repository"
                hint={
                  gh === "loading" || gh === null
                    ? "Checking the GitHub CLI…"
                    : !gh.installed
                      ? "Needs the GitHub CLI: brew install gh && gh auth login."
                      : !gh.loggedIn
                        ? "The GitHub CLI isn't logged in: run gh auth login."
                        : !state.git
                          ? "Needs git (above)."
                          : `Off by default. Runs only when this is on${gh.login ? `, as ${gh.login}` : ""}.`
                }
                checked={state.github && ghReady && state.git}
                disabled={!ghReady || !state.git}
                onChange={(v) => patch({ github: v })}
              >
                {ghReady && state.git ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Segmented
                        label="Visibility"
                        value={state.visibility}
                        options={[
                          { value: "private", label: "Private" },
                          { value: "public", label: "Public" },
                        ]}
                        onChange={(v) => patch({ visibility: v })}
                        className="h-8"
                      />
                      <Input
                        aria-label="Repository name"
                        value={state.repoName}
                        onChange={(e) => patch({ repoName: e.target.value })}
                        placeholder={repoNameFor({ name: state.name, repoName: "" })}
                        spellCheck={false}
                        className={cn(fieldClass, "h-8 w-56 font-mono text-ui-sm")}
                      />
                    </div>
                    <div className="rounded-lg bg-surface-2 px-3 py-2">
                      <p className="text-meta text-muted-foreground">
                        {state.github
                          ? willCommit
                            ? "Runs in the new folder after the first commit:"
                            : "Runs in the new folder (no first commit, so nothing is pushed):"
                          : "Would run (turn the switch on to create the repository):"}
                      </p>
                      <code className="mt-1 block font-mono text-[11.5px] break-all text-foreground select-text">
                        {ghCommand(state, defaults?.git.identity !== false)}
                      </code>
                    </div>
                  </div>
                ) : null}
              </OptionRow>

              {systems.length ? (
                <OptionRow
                  id="np-system"
                  icon={Layers}
                  title="Add to a system"
                  hint="List the new repo in a multi-repo system's ruah.system.json; its map picks it up the next time it opens."
                  checked={state.system !== null}
                  onChange={(v) => patch({ system: v ? (systems[0]?.root ?? null) : null })}
                >
                  {state.system !== null ? (
                    <select
                      aria-label="System"
                      value={state.system}
                      onChange={(e) => patch({ system: e.target.value })}
                      className="h-8 w-full rounded-lg border border-hairline bg-surface-2 px-2 text-ui-sm text-foreground"
                    >
                      {systems.map((s) => (
                        <option key={s.id} value={s.root}>
                          {s.name} — {prettyPath(s.root)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </OptionRow>
              ) : null}

              <OptionRow
                id="np-agent"
                icon={Sparkles}
                title="Ask the agent to set it up"
                hint="Opens the agent with a first prompt once the project is open. You can edit it."
                checked={state.askAgent}
                onChange={(v) => patch({ askAgent: v })}
              >
                {state.askAgent ? (
                  <Textarea
                    aria-label="First prompt"
                    value={state.prompt}
                    onChange={(e) => {
                      setPromptEdited(true);
                      patch({ prompt: e.target.value });
                    }}
                    rows={3}
                    className="rounded-lg border-hairline bg-surface-2 text-ui-sm md:text-ui-sm"
                  />
                ) : null}
              </OptionRow>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
          {!connected ? <p className="mt-4 text-meta text-warn">No daemon connected — creating needs the Ruah app.</p> : null}
        </div>

        <div className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <p className="min-w-0 flex-1 truncate text-meta text-muted-foreground" title={finalPath}>
            {state.name.trim() && step > 0 ? (
              <>
                <span className="font-medium text-foreground">{state.name.trim()}</span>
                {` · ${template?.name ?? "Empty"}${state.git ? (state.commit ? " · git + first commit" : " · git") : ""}${state.github && ghReady ? ` · GitHub (${state.visibility})` : ""}${state.system ? " · in a system" : ""}${state.askAgent ? " · agent sets it up" : ""}`}
              </>
            ) : (
              <span className="flex items-center gap-1.5">
                <kbd className="kbd">↵</kbd> next <kbd className="kbd ms-2">⌘↵</kbd> create
              </span>
            )}
          </p>
          {step > 0 ? (
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-ui-sm" onClick={() => setStep((s) => (s - 1) as WizardStep)} disabled={busy}>
              <ArrowLeft className="size-3.5" /> Back
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-8 text-ui-sm" onClick={() => wb.setNewProjectOpen(false)} disabled={busy}>
              Cancel
            </Button>
          )}
          {step < 2 ? (
            <>
              {step === 0 && readyToCreate ? (
                <Button variant="outline" size="sm" className="h-8 rounded-lg border-hairline text-ui-sm shadow-none" onClick={() => void submit()} title="Create with these choices (⌘↵)">
                  Create now
                </Button>
              ) : null}
              <Button size="sm" className="h-8 gap-1 rounded-lg text-ui-sm" disabled={!stepOk || !connected} onClick={next}>
                Next <ArrowRight className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8 gap-1.5 rounded-lg text-ui-sm" disabled={!readyToCreate} onClick={() => void submit()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? "Creating…" : "Create project"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

