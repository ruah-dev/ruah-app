// "Keyboard shortcuts" (launcher item / footer): every shortcut from shell/nav.ts, grouped.
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SHORTCUTS, type ShortcutDef } from "./nav";
import { setShellDialog, useShellDialogs } from "./shellState";

const GROUPS: ShortcutDef["group"][] = ["Anywhere", "Projects & chats", "Map", "Agent", "Launcher"];

export function ShortcutsDialog() {
  const open = useShellDialogs().shortcuts;
  return (
    <Dialog open={open} onOpenChange={(v) => setShellDialog("shortcuts", v)}>
      <DialogContent className="flex max-h-[min(84vh,720px)] max-w-2xl flex-col gap-0 p-0">
        <div className="border-b border-hairline px-5 pt-4 pb-3">
          <DialogTitle className="text-ui font-medium">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-meta text-muted-foreground">
            ⌘ is Ctrl on Windows and Linux. Shortcuts pause while you type, except ⌘ ones.
          </DialogDescription>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-8 gap-y-5 overflow-y-auto px-5 py-4 max-md:grid-cols-1">
          {GROUPS.map((g) => (
            <section key={g} className="min-w-0">
              <h3 className="section-label pb-1.5 uppercase tracking-[0.08em]">{g}</h3>
              <dl className="divide-y divide-hairline">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.keys + s.label} className="flex items-baseline gap-3 py-1.5">
                    <dt className="w-32 shrink-0">
                      <kbd className="kbd whitespace-nowrap">{s.keys}</kbd>
                    </dt>
                    <dd className="min-w-0 text-ui-sm text-foreground/90">{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
