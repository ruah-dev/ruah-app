// Journey exports (CONTRACTS §23.7 GET /api/product/export): a storyboard (self-contained HTML)
// or Markdown, of one journey or all. Fetched first so daemon errors show as a toast instead of
// being saved as the file, then handed to the browser as a download.
import { toast } from "sonner";
import { daemonSnapshot, SAMPLE_MODE_MESSAGE } from "./daemon";

function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition !== null ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

export async function downloadProductExport(httpOrigin: string | null, format: "html" | "md", journeyId?: string): Promise<void> {
  if (daemonSnapshot().source === "sample") {
    toast.error(SAMPLE_MODE_MESSAGE);
    return;
  }
  if (httpOrigin === null) {
    toast.error("Ruah isn't connected", { description: "Start the Ruah app (or ruah app serve), then export again." });
    return;
  }
  const what = format === "html" ? "storyboard" : "Markdown";
  const pending = toast.loading(`Exporting the ${what}…`);
  try {
    const query = new URLSearchParams({ format, ...(journeyId !== undefined ? { journey: journeyId } : {}) });
    const res = await fetch(`${httpOrigin}/api/product/export?${query.toString()}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `export failed (${res.status})`);
    }
    const name = fileNameFrom(res.headers.get("content-disposition"), format === "html" ? "journeys.html" : "journeys.md");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast.success(`Exported ${name}`, { id: pending, description: format === "html" ? "Opens in any browser, offline; share it with people who don't use Ruah." : "Paste it into a PR or a doc." });
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
    toast.error(`Couldn't export the ${what}`, { id: pending, description: `${reason}. Or run ruah app journeys export in a terminal.` });
  }
}
