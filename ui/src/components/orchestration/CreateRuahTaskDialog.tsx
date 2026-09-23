// Create a ruah task (`ruah task create` [+ `start`]) — from an element's Details (prompt and
// file locks prefilled from the element) or from the Tasks page (blank).
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import {
  RUAH_EXECUTORS,
  RUAH_TASK_NAME,
  createRuahTask,
  elementFileGlobs,
  elementTaskPrompt,
  slugTaskName,
} from "@/lib/integrations";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { primaryButton, quietButton } from "@/components/integrations/common";

const EXECUTOR_KEY = "ruah.task.executor";

function readExecutor(): string {
  try {
    return window.localStorage.getItem(EXECUTOR_KEY) ?? "claude-code";
  } catch {
    return "claude-code";
  }
}

export function CreateRuahTaskDialog({
  open,
  onOpenChange,
  node,
  existingNames = [],
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node?: DiagramNode | null;
  existingNames?: string[];
  onCreated?: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState("");
  const [executor, setExecutor] = useState("claude-code");
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let base = node ? slugTaskName(node.label) : "";
    if (base && existingNames.includes(base)) {
      let i = 2;
      while (existingNames.includes(`${base}-${i}`)) i++;
      base = `${base}-${i}`;
    }
    setName(base);
    setPrompt(node ? elementTaskPrompt(node) : "");
    setFiles(node ? elementFileGlobs(node).join("\n") : "");
    setExecutor(readExecutor());
    setStart(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node?.id]);

  const nameValid = RUAH_TASK_NAME.test(name);
  const taken = existingNames.includes(name);
  const promptText = prompt.trim();
  const valid = nameValid && !taken && promptText.length > 0 && !/Task:\s*$/.test(promptText);
  const fileList = files
    .split(/[\n,]/)
    .map((f) => f.trim())
    .filter(Boolean);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      window.localStorage.setItem(EXECUTOR_KEY, executor);
    } catch {
      /* storage unavailable */
    }
    const res = await createRuahTask({
      name,
      prompt: promptText,
      executor,
      start,
      ...(fileList.length ? { files: fileList } : {}),
      ...(node ? { nodeId: node.id } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated?.(name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5 rounded-xl p-5">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-[15px]">Create ruah task</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {node
              ? `Runs an agent on ${node.label} in its own git worktree; the files below are locked for it.`
              : "Runs an agent in its own git worktree; listed files are locked for it."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3 max-sm:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="task-name" className="text-[12.5px] font-normal text-muted-foreground">
                Name
              </Label>
              <Input
                id="task-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
                placeholder="fix-invoice-validation"
                spellCheck={false}
                className="h-8 font-mono text-[13px] md:text-[13px]"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal text-muted-foreground">Executor</Label>
              <Select value={executor} onValueChange={setExecutor}>
                <SelectTrigger className="h-8 text-[13px] md:text-[13px]" aria-label="Executor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUAH_EXECUTORS.map((x) => (
                    <SelectItem key={x.id} value={x.id} className="text-[13px]">
                      {x.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {name && !nameValid ? (
            <p className="-mt-2 text-[12px] text-warn">
              Lower-case letters, digits, “-” and “_”, starting with a letter or digit (max 64).
            </p>
          ) : taken ? (
            <p className="-mt-2 text-[12px] text-warn">A task with this name already exists.</p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="task-prompt" className="text-[12.5px] font-normal text-muted-foreground">
              Prompt
            </Label>
            <Textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              placeholder="What should the agent do?"
              className="max-h-64 resize-y text-[12.5px] leading-relaxed md:text-[12.5px]"
            />
            {node && /Task:\s*$/.test(promptText) ? (
              <p className="text-[12px] text-muted-foreground">Finish the prompt after “Task:”.</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-files" className="text-[12.5px] font-normal text-muted-foreground">
              Files to lock <span className="text-faint">· globs, one per line</span>
            </Label>
            <Textarea
              id="task-files"
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              rows={3}
              placeholder="src/api/**"
              spellCheck={false}
              className="max-h-40 resize-y font-mono text-[12px] leading-relaxed md:text-[12px]"
            />
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-foreground/90">
            <Checkbox checked={start} onCheckedChange={(v) => setStart(v === true)} />
            Start now
            <span className="text-muted-foreground">— otherwise it waits in the Tasks list</span>
          </label>

          {error ? <p className="text-[12.5px] text-bad">{error}</p> : null}

          <DialogFooter className="gap-2 sm:gap-1">
            <button type="button" className={quietButton} onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className={primaryButton} disabled={!valid || busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {start ? "Create and start" : "Create task"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
