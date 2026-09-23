// One terminal tab: an xterm.js instance attached to a daemon PTY (CONTRACTS §7). xterm and
// its addons load on first use (dynamic import) so the app bundle and the SPA prerender never
// touch them. Keys: the terminal owns every plain and Ctrl key while focused (Ctrl-B, Ctrl-K,
// Esc … go to the shell, not the app); ⌘K clears, ⌘F searches, ⌘T opens a tab, ⌘= / ⌘- / ⌘0
// set the font size; other ⌘ shortcuts (⌘P, ⌘B, ⌘J, ⌘1…) stay the app's.
import { useEffect, useRef, useState } from "react";
import type { ITerminalAddon, Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  DEFAULT_FONT,
  attachView,
  lastSize,
  rendered,
  resizeTerminal,
  sendInput,
  terminalActions,
  type TerminalInfo,
} from "@/lib/terminal";
import { findPaths, projectPathOf, safeExternalUrl } from "@/lib/terminal-links";
import { cn } from "@/lib/utils";
import { terminalTheme, watchTheme } from "./theme";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// Geist Mono first; installed Nerd Fonts next so prompt/`eza --icons` glyphs render instead of boxes.
const FONT_FAMILY =
  '"Geist Mono", "Symbols Nerd Font Mono", "MesloLGS NF", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

/** Opens a web URL outside the app: the desktop bridge, else a new browser tab. */
export function openExternal(raw: string) {
  const url = safeExternalUrl(raw);
  if (!url) return;
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  if (bridge?.openExternal) bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function searchColors() {
  const light = document.documentElement.dataset["theme"] === "light";
  return light
    ? { matchBackground: "#fae8c2", activeMatchBackground: "#edbf5e", matchOverviewRuler: "#d09430", activeMatchColorOverviewRuler: "#8a6118" }
    : { matchBackground: "#674810", activeMatchBackground: "#ad7a22", matchOverviewRuler: "#e5a84b", activeMatchColorOverviewRuler: "#edbf5e" };
}

/** `localStorage["ruah.terminal.renderer"] = "dom"` turns the GPU renderer off (driver trouble). */
function domRendererOnly(): boolean {
  try {
    return window.localStorage.getItem("ruah.terminal.renderer") === "dom";
  } catch {
    return false;
  }
}

interface Loaded {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  SearchAddon: typeof import("@xterm/addon-search").SearchAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
  WebglAddon: typeof import("@xterm/addon-webgl").WebglAddon;
}

let loading: Promise<Loaded> | undefined;
function loadXterm(): Promise<Loaded> {
  loading ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-search"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-webgl"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([x, fit, search, links, webgl]) => ({
    Terminal: x.Terminal,
    FitAddon: fit.FitAddon,
    SearchAddon: search.SearchAddon,
    WebLinksAddon: links.WebLinksAddon,
    WebglAddon: webgl.WebglAddon,
  }));
  return loading;
}

export function TerminalView({
  terminal,
  active,
  visible,
  fontSize,
  focusSignal,
  projectRoot,
  onOpenPath,
}: {
  terminal: TerminalInfo;
  /** The selected tab (receives focus requests, loads the GPU renderer). */
  active: boolean;
  /** Painted on screen (active tab of an open panel). */
  visible: boolean;
  fontSize: number;
  focusSignal: number;
  projectRoot: string | null;
  onOpenPath: (path: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<(ITerminalAddon & { dispose(): void }) | null>(null);
  const libRef = useRef<Loaded | null>(null);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ terminal, projectRoot, onOpenPath, fontSize, visible });
  latest.current = { terminal, projectRoot, onOpenPath, fontSize, visible };
  const id = terminal.id;

  // ---- create the xterm instance once per tab
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      let lib: Loaded;
      try {
        lib = await loadXterm();
        await document.fonts?.load(`${latest.current.fontSize}px "Geist Mono"`).catch(() => undefined);
      } catch (err) {
        setFailed(err instanceof Error ? err.message : String(err));
        return;
      }
      if (disposed || !hostRef.current) return;
      libRef.current = lib;
      const term = new lib.Terminal({
        fontFamily: FONT_FAMILY,
        fontSize: latest.current.fontSize || DEFAULT_FONT,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10_000,
        allowProposedApi: true, // search match decorations
        macOptionIsMeta: false,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        drawBoldTextInBrightColors: false,
        theme: terminalTheme(),
        linkHandler: {
          // OSC 8 hyperlinks printed by tools (ls --hyperlink, gh, cargo …): web pages only.
          activate: (event, text) => {
            if (event.metaKey || event.ctrlKey) openExternal(text);
          },
          hover: (_e, text) => setHint(`${IS_MAC ? "⌘" : "Ctrl"}-click to open ${text}`),
          leave: () => setHint(null),
        },
      });
      const fit = new lib.FitAddon();
      const search = new lib.SearchAddon({ highlightLimit: 1000 });
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(
        new lib.WebLinksAddon(
          (event, uri) => {
            if (event.metaKey || event.ctrlKey) openExternal(uri);
          },
          {
            hover: (_e, text) => setHint(`${IS_MAC ? "⌘" : "Ctrl"}-click to open ${text}`),
            leave: () => setHint(null),
          },
        ),
      );
      // File paths: ⌘-click opens the Code view on that file (and line).
      const pathLinks = term.registerLinkProvider({
          provideLinks(y, callback) {
            const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
            const { terminal: info, projectRoot: root } = latest.current;
            if (!root || !line.includes("/")) {
              callback(undefined);
              return;
            }
            const links = findPaths(line)
              .map((m) => ({ m, rel: projectPathOf(m.path, info.cwd, root) }))
              .filter((x): x is { m: (typeof x)["m"]; rel: string } => x.rel !== null)
              .map(({ m, rel }) => ({
                range: { start: { x: m.index + 1, y }, end: { x: m.index + m.text.length, y } },
                text: m.text,
                activate: (event: MouseEvent) => {
                  if (!(event.metaKey || event.ctrlKey)) return;
                  latest.current.onOpenPath(rel, m.line);
                },
                hover: () => setHint(`${IS_MAC ? "⌘" : "Ctrl"}-click to open ${rel}${m.line ? `:${m.line}` : ""}`),
                leave: () => setHint(null),
              }));
            callback(links.length ? links : undefined);
          },
      });
      cleanups.push(() => pathLinks.dispose());
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const mod = IS_MAC ? e.metaKey : e.ctrlKey && e.shiftKey;
        const k = e.key.toLowerCase();
        // ⌃` toggles the panel (TerminalPanel's window listener); never send it to the shell.
        if (e.ctrlKey && e.code === "Backquote") return false;
        if (!mod || e.altKey) return true;
        if (k === "k") {
          e.preventDefault();
          term.clear();
          terminalActions.clear(id);
          return false;
        }
        if (k === "f") {
          e.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.select());
          return false;
        }
        if (k === "t") {
          e.preventDefault();
          void terminalActions.create().catch(() => undefined);
          return false;
        }
        if (k === "=" || k === "+") {
          e.preventDefault();
          terminalActions.setFontSize(latest.current.fontSize + 1);
          return false;
        }
        if (k === "-") {
          e.preventDefault();
          terminalActions.setFontSize(latest.current.fontSize - 1);
          return false;
        }
        if (k === "0") {
          e.preventDefault();
          terminalActions.setFontSize(DEFAULT_FONT);
          return false;
        }
        if (k === "a") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        if (k === "c" && !IS_MAC && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        return true; // ⌘C / ⌘V: the browser's copy/paste events, which xterm handles
      });
      const host = hostRef.current;
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;
      const onData = term.onData((data) => sendInput(id, data));
      const onResults = search.onDidChangeResults((r) => setResults({ index: r.resultIndex, count: r.resultCount }));
      cleanups.push(
        () => onData.dispose(),
        () => onResults.dispose(),
        watchTheme(() => {
          term.options.theme = terminalTheme();
        }),
      );
      // Keys typed in the terminal stay in the terminal: stop them before the app's window
      // listeners (shortcuts, the map's Backspace/arrows, Enter on a permission card). ⌘ combos
      // the terminal does not own bubble on to the app.
      const own = (e: KeyboardEvent) => {
        const k = e.key.toLowerCase();
        if (e.ctrlKey && e.code === "Backquote") return;
        if (IS_MAC && e.metaKey) {
          if (!["k", "f", "t", "=", "+", "-", "0", "a", "c", "v", "x", "z"].includes(k)) return;
        }
        e.stopPropagation();
      };
      host.addEventListener("keydown", own);
      cleanups.push(() => host.removeEventListener("keydown", own));

      // Output: replay on attach, then the stream; acknowledge what xterm has rendered.
      let exitWritten = false;
      const writeExit = (code: number | null, signal: number | null) => {
        if (exitWritten) return;
        exitWritten = true;
        const what = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
        term.write(`\r\n\x1b[2m[process exited with ${what} — close the tab or open a new one]\x1b[0m\r\n`);
      };
      cleanups.push(
        attachView(id, {
          onAttached(replay) {
            exitWritten = false;
            term.reset();
            if (replay) term.write(replay);
            // The daemon learns our size (the PTY may have been created for another viewer).
            requestAnimationFrame(() => {
              if (!latest.current.visible) return;
              try {
                fit.fit();
              } catch {
                /* hidden */
              }
              resizeTerminal(id, term.cols, term.rows);
            });
          },
          onOutput(data) {
            term.write(data, () => rendered(id, data.length));
          },
          onExit(code, signal) {
            // `exit` (status 0) closes the tab like other terminals; anything else stays readable.
            if (code === 0 && !signal) terminalActions.kill(id);
            else writeExit(code, signal);
          },
        }),
      );
      setReady(true);
    })();
    return () => {
      disposed = true;
      for (const c of cleanups.splice(0)) c();
      webglRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [id]);

  // ---- fit to the panel: on show, on resize of the host, on font changes
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!ready || !term || !fit || !host || !visible) return;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth < 20 || host.clientHeight < 20) return;
        const before = `${term.cols}x${term.rows}`;
        try {
          fit.fit();
        } catch {
          return;
        }
        lastSize.cols = term.cols;
        lastSize.rows = term.rows;
        if (`${term.cols}x${term.rows}` !== before) resizeTerminal(id, term.cols, term.rows);
      });
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [ready, visible, id]);

  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    if (!visible) return;
    try {
      fitRef.current?.fit();
      resizeTerminal(id, term.cols, term.rows);
    } catch {
      /* hidden */
    }
  }, [ready, fontSize, visible, id]);

  // ---- GPU renderer for the visible tab only (browsers cap live WebGL contexts)
  useEffect(() => {
    const term = termRef.current;
    const lib = libRef.current;
    if (!ready || !term || !lib) return;
    if (visible && !webglRef.current && !domRendererOnly()) {
      try {
        const webgl = new lib.WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (webglRef.current === webgl) webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        webglRef.current = null; // no WebGL: the DOM renderer stays
      }
    } else if (!visible && webglRef.current) {
      webglRef.current.dispose();
      webglRef.current = null;
    }
  }, [ready, visible]);

  useEffect(() => {
    if (ready && active && visible && focusSignal > 0) termRef.current?.focus();
  }, [ready, active, visible, focusSignal]);

  const runSearch = (direction: "next" | "prev", q = query) => {
    const search = searchRef.current;
    if (!search) return;
    if (!q) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    const opts = { decorations: searchColors(), incremental: direction === "next" };
    if (direction === "next") search.findNext(q, opts);
    else search.findPrevious(q, opts);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    setResults(null);
    termRef.current?.focus();
  };

  return (
    <div className={cn("relative h-full min-h-0 w-full", !visible && "hidden")} data-ruah-terminal={id}>
      <div ref={hostRef} className="h-full w-full overflow-hidden" style={{ background: "var(--term-bg)" }} />
      {failed ? (
        <p className="absolute inset-0 grid place-items-center p-6 text-ui-sm text-bad">Terminal failed to load: {failed}</p>
      ) : null}
      {searchOpen ? (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-hairline bg-popover p-1 shadow-elevated">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            placeholder="Find"
            aria-label="Find in terminal"
            onChange={(e) => {
              setQuery(e.target.value);
              runSearch("next", e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(e.shiftKey ? "prev" : "next");
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            className="h-6 w-44 rounded-md bg-transparent px-2 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint"
          />
          <span className="min-w-12 text-center text-meta text-muted-foreground tabular-nums">
            {results ? (results.count === 0 ? "0" : results.index >= 0 ? `${results.index + 1}/${results.count}` : `${results.count}+`) : ""}
          </span>
          <button type="button" aria-label="Previous match" onClick={() => runSearch("prev")} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" aria-label="Next match" onClick={() => runSearch("next")} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowDown className="size-3.5" />
          </button>
          <button type="button" aria-label="Close search" onClick={closeSearch} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {hint ? (
        <p className="pointer-events-none absolute right-3 bottom-2 max-w-[60%] truncate rounded-md border border-hairline bg-popover px-2 py-0.5 font-mono text-meta text-muted-foreground shadow-card">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
