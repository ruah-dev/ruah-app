// Settings → Appearance rows for the shell layout (./layout.ts): Layout (Standard | Advanced,
// ⌘\) and Rail labels (Standard only). `Row` is the Settings page's own row, so the look stays
// the page's.
import type { ComponentType, ReactNode } from "react";
import type { LayoutMode } from "@/lib/preferences";
import { useViewerPrefs } from "@/lib/preferences";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { ADVANCED_MIN_WIDTH, LAYOUT_SHORTCUT, setLayout, setRailLabels, useShellLayout } from "./layout";

type RowComponent = ComponentType<{ label: string; hint?: ReactNode; children: ReactNode }>;

export function LayoutSettingsRows({ Row }: { Row: RowComponent }) {
  const prefs = useViewerPrefs();
  const layout = useShellLayout();
  return (
    <>
      <Row
        label="Layout"
        hint={
          <>
            Standard: the icon rail with your projects; recent chats above the agent panel. Advanced: a sidebar
            with Projects and Chats. <kbd className="kbd">{LAYOUT_SHORTCUT}</kbd> switches.
            {layout.folded ? ` The sidebar shows once the window is ${ADVANCED_MIN_WIDTH} px wide.` : ""}
          </>
        }
      >
        <Segmented
          label="Layout"
          value={prefs.layout}
          onChange={(v: LayoutMode) => setLayout(v)}
          options={[
            { value: "standard", label: "Standard" },
            { value: "advanced", label: "Advanced" },
          ]}
        />
      </Row>
      <Row label="Rail labels" hint="Names under the rail's icons (Standard layout). Off: the bare icon rail.">
        <Switch
          checked={prefs.railLabels}
          onCheckedChange={setRailLabels}
          disabled={layout.effective === "advanced"}
          aria-label="Show labels under the rail icons"
        />
      </Row>
    </>
  );
}
