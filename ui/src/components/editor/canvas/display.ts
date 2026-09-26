// What a map card and an edge label show — pure, so the canvas stays a renderer.
//
// Infrastructure elements are named "<Tool>: <what>" by the IaC scan ("Kubernetes: prod",
// "Helm: api", "CI/CD: GitHub Actions") and carry the tool again as their subtitle. On a 200 px
// card the name was cut to "Kubernetes: …" twice in a row, so two different clusters looked the
// same. A full card shows the part that differs as its name and the tool as its second line;
// the full name stays the tooltip (and what zoomed-out cards show, where there is one line).

export type CardText = { title: string; subtitle: string | undefined; full: string };

const TOOL_PREFIX = /^([^:]{2,28}):\s+(\S.*)$/;

export function cardText(node: { label: string; subtitle?: string | undefined; tech?: readonly string[] | undefined }): CardText {
  const full = node.label;
  const m = TOOL_PREFIX.exec(full);
  if (!m) return { title: full, subtitle: node.subtitle, full };
  const tool = m[1]!.trim();
  const rest = m[2]!.trim();
  const sub = node.subtitle?.trim() ?? "";
  const same = (a: string) => a.toLowerCase() === tool.toLowerCase();
  const toolIsSubtitle = sub !== "" && (same(sub) || same(sub.split(" · ")[0] ?? ""));
  const toolIsTech = (node.tech ?? []).some(same);
  if (!toolIsSubtitle && !toolIsTech) return { title: full, subtitle: node.subtitle, full };
  return { title: rest, subtitle: sub !== "" ? sub : tool, full };
}

/** A card's second line in the parts it is made of ("TypeScript · Express 4" → two parts). The
 * card drops whole trailing parts that do not fit instead of cutting a word ("TypeScri…"). */
export function subtitleParts(subtitle: string): string[] {
  return subtitle
    .split(" · ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Right padding the second line leaves for the "▸ n" chip: it grows with the count's digits. */
export function chipPad(childCount: number | undefined): "pr-7" | "pr-9" {
  return (childCount ?? 0) >= 10 ? "pr-9" : "pr-7";
}

/** Edge labels are drawn in world units; this keeps them ~10 px on screen when zoomed out
 * (same rule as the card text: grow with 1 / zoom below 90 %, capped so they never balloon). */
export function edgeLabelScale(kq: number): number {
  if (!(kq > 0)) return 1;
  return Math.min(2.4, Math.max(1, 0.9 / kq));
}

/** Deployment / build links (IaC → what it runs) are drawn quieter than runtime calls, so the
 * INFRA lane's many "deploys" / "runs" edges do not bury the data flow. */
export function isQuietEdgeKind(kind: string | undefined): boolean {
  return kind === "deploy";
}
