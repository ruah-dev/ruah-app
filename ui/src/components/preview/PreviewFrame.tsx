// The page itself: an iframe (sandboxed: no top navigation) sized to the chosen device width and
// scaled down to fit; for sites that refuse framing (X-Frame-Options / CSP frame-ancestors) an
// Electron <webview> in its own session when the desktop app allows it (§15.6), else a way out
// to the browser. Hot reload is the dev server's own (Vite / Next HMR run inside the frame).
import { useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { DEVICES, fitScale, type Device } from "@/lib/preview";
import { cn } from "@/lib/utils";

export function openInBrowser(url: string) {
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  if (bridge?.openExternal) bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

type WebviewElement = HTMLElement & { reload?: () => void; getURL?: () => string };

function Webview({ url, reloadKey, onNavigate }: { url: string; reloadKey: number; onNavigate?: ((url: string) => void) | undefined }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<WebviewElement | null>(null);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let wv: WebviewElement | null = null;
    const onNav = (e: Event) => {
      const next = (e as Event & { url?: string }).url;
      if (typeof next === "string") navigate.current?.(next);
    };
    // Created a tick later: a webview removed before it attached (StrictMode's double effect)
    // makes Electron throw "Invalid guestInstanceId".
    const timer = setTimeout(() => {
      wv = document.createElement("webview") as WebviewElement;
      // Its own persistent session: the previewed app never shares cookies or storage with Ruah.
      wv.setAttribute("partition", "persist:ruah-preview");
      wv.setAttribute("src", url);
      wv.style.width = "100%";
      wv.style.height = "100%";
      wv.style.display = "flex";
      wv.addEventListener("did-navigate", onNav);
      wv.addEventListener("did-navigate-in-page", onNav);
      el.appendChild(wv);
      view.current = wv;
    }, 0);
    return () => {
      clearTimeout(timer);
      if (wv) {
        wv.removeEventListener("did-navigate", onNav);
        wv.removeEventListener("did-navigate-in-page", onNav);
        wv.remove();
      }
      view.current = null;
    };
  }, [url]);
  const firstKey = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey === firstKey.current) return;
    try {
      view.current?.reload?.();
    } catch {
      /* not attached yet */
    }
  }, [reloadKey]);
  return <div ref={host} className="flex size-full bg-white" />;
}

export interface PreviewFrameProps {
  url: string;
  device: Device;
  /** Bumped to reload the page. */
  reloadKey: number;
  framing: "ok" | "blocked" | "unknown";
  title: string;
  /** The webview reports navigations (an iframe cannot: cross-origin). */
  onNavigate?: (url: string) => void;
}

export function PreviewFrame({ url, device, reloadKey, framing, title, onNavigate }: PreviewFrameProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const deviceWidth = DEVICES[device].width;
  const scale = fitScale(size.width, deviceWidth);
  const webviewOk = typeof window !== "undefined" && window.ruah?.previewWebview === true;
  const blocked = framing === "blocked";

  const page = blocked ? (
    webviewOk ? (
      <Webview url={url} reloadKey={reloadKey} onNavigate={onNavigate} />
    ) : (
      <div className="grid size-full place-items-center bg-surface-1 p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <ShieldAlert className="size-7 text-warn" />
          <p className="heading text-title text-foreground">This page can’t be shown inside Ruah</p>
          <p className="text-ui-sm text-muted-foreground">
            The site sends <span className="font-mono text-meta">X-Frame-Options</span> or a CSP{" "}
            <span className="font-mono text-meta">frame-ancestors</span> rule that forbids frames. Open it in your browser
            instead — or use the desktop app, which shows such pages in a separate view.
          </p>
          <button
            type="button"
            onClick={() => openInBrowser(url)}
            className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-ui-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <ExternalLink className="size-3.5" /> Open in browser
          </button>
        </div>
      </div>
    )
  ) : (
    <iframe
      key={reloadKey}
      src={url}
      title={title}
      // Scripts and the app's own origin (storage, HMR socket), forms, popups — never top navigation.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation"
      // No camera / microphone / location: Electron would grant them without asking.
      allow="clipboard-write; fullscreen"
      className="block size-full border-0 bg-white"
    />
  );

  return (
    <div ref={ref} className={cn("relative min-h-0 flex-1 overflow-hidden", deviceWidth !== null && "bg-surface-0")}>
      {deviceWidth === null ? (
        page
      ) : (
        <div className="absolute inset-x-0 top-0 flex justify-center pt-4">
          <div
            className="overflow-hidden rounded-[14px] border border-hairline bg-white shadow-elevated"
            style={{
              width: deviceWidth,
              height: Math.max(200, (size.height - 32) / scale),
              transform: `scale(${scale})`,
              transformOrigin: "top center",
            }}
          >
            {page}
          </div>
        </div>
      )}
    </div>
  );
}
