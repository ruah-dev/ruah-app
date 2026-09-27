// §23.8: screenshots of the live preview for journey screens. The desktop app photographs the
// preview (a rectangle of its window for an iframe, the webview's own contents otherwise); the
// daemon stores it in .ruah/shots/ and sets the screen's `shot`.
import { toast } from "sonner";

type WebviewWithId = HTMLElement & { getWebContentsId?: () => number };

export function canCapturePreview(): boolean {
  return typeof window !== "undefined" && typeof window.ruah?.capturePreview === "function";
}

export async function capturePreviewImage(): Promise<string | null> {
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  if (!bridge?.capturePreview) return null;
  const el = document.querySelector<HTMLElement>("[data-preview-page]");
  if (!el) return null;
  const webview = el.querySelector("webview") as WebviewWithId | null;
  let id: number | undefined;
  try {
    id = webview?.getWebContentsId?.();
  } catch {
    id = undefined;
  }
  if (typeof id === "number") return bridge.capturePreview({ webviewId: id });
  const r = el.getBoundingClientRect();
  return bridge.capturePreview({ rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
}

/** Captures the preview and attaches it to `screenId`. Toasts the outcome. */
export async function captureForScreen(httpOrigin: string | null, screenId: string, screenName: string): Promise<boolean> {
  if (httpOrigin === null) {
    toast.error("Ruah isn't connected");
    return false;
  }
  const pending = toast.loading(`Capturing ${screenName}…`);
  try {
    const image = await capturePreviewImage();
    if (image === null) throw new Error("the preview could not be captured (is it visible?)");
    const res = await fetch(`${httpOrigin}/api/product/shot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen: screenId, image }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `saving failed (${res.status})`);
    toast.success(`Screenshot saved for ${screenName}`, { id: pending, description: "Kept in .ruah/shots on this Mac; storyboard exports include it." });
    return true;
  } catch (err) {
    toast.error("Couldn't capture the screen", { id: pending, description: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
