export type DockTarget = { url: string; mock: boolean };

export interface ArchmapDock {
  connection(): Promise<DockTarget | null>;
  openRepository(): Promise<DockTarget | null>;
  openDemo(): Promise<DockTarget>;
}

declare global {
  interface Window {
    archmap?: ArchmapDock;
  }
}

export function dock(): ArchmapDock | null {
  return window.archmap ?? null;
}

export function normalizeTarget(target: DockTarget): DockTarget {
  const url = new URL(target.url);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("The daemon must use a local HTTP or WebSocket URL.");
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return { url: url.href, mock: target.mock };
}

export async function resolveTarget(): Promise<DockTarget | null> {
  const bridge = dock();
  if (bridge) {
    const target = await bridge.connection();
    return target ? normalizeTarget(target) : null;
  }
  const query = new URLSearchParams(window.location.search).get("daemon");
  if (query) return normalizeTarget({ url: query, mock: false });
  if (["http:", "https:"].includes(location.protocol)) {
    return normalizeTarget({ url: location.origin, mock: false });
  }
  return null;
}
