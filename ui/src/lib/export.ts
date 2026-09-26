// Export downloads (CONTRACTS.md §2.3 GET /api/export/drawio). The file is
// fetched first so daemon errors (409 no project, 5xx) show as a toast instead
// of being saved as a .drawio file, then handed to the browser as a download
// (in the desktop app Electron's will-download shows the save dialog).
import { toast } from "sonner";

function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition !== null ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

export async function downloadDrawio(httpOrigin: string | null): Promise<void> {
  if (httpOrigin === null) {
    toast.error("Ruah isn't connected", { description: "Start the Ruah app (or ruah app serve), then export again." });
    return;
  }
  const pending = toast.loading("Exporting to draw.io…");
  try {
    const res = await fetch(`${httpOrigin}/api/export/drawio`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `export failed (${res.status})`);
    }
    const name = fileNameFrom(res.headers.get("content-disposition"), "architecture.drawio");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast.success(`Exported ${name}`, { id: pending, description: "Open it in draw.io / diagrams.net." });
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
    toast.error("Couldn't export to draw.io", {
      id: pending,
      description: `${reason}. Try again, or run ruah app export drawio <repo> in a terminal.`,
    });
  }
}
