// What the shell stores in the per-project view state (CONTRACTS.md §13.5) and how it reads it
// back: active page, map level (drill path) and camera, the left drawer, the agent panel (open,
// view, width). The daemon treats it as opaque; unknown keys are kept so other writers survive.
// Pure; unit-tested in ui/test/view-restore.test.ts.
import type { ViewState } from "./contracts";

/**
 * The pages of one project: the ones a project's view remembers and a switch back returns to.
 * "/?view=project" is the project's dashboard ("/" alone is the global Home, §20).
 */
export const PROJECT_PAGES = ["/map", "/agent", "/tasks", "/cloud", "/preview", "/?view=project"] as const;
export type ProjectPage = (typeof PROJECT_PAGES)[number];
/**
 * Everything an older view may hold. Home, Chats, Usage, Integrations and Settings are app-wide:
 * storing one as a project's page made a later switch back land there (Home looks the same for
 * every project, so the switch seemed to do nothing). They are read, never restored.
 */
export const SHELL_PAGES = [...PROJECT_PAGES, "/", "/chats", "/usage", "/integrations", "/settings"] as const;
export type ShellPage = (typeof SHELL_PAGES)[number];

export type PanelViewName = "agent" | "details" | "code" | "properties";
const PANEL_VIEWS: readonly PanelViewName[] = ["agent", "details", "code", "properties"];

export interface Camera {
  x: number;
  y: number;
  k: number;
  /** "Fit to view" framed by the canvas, not a pan / zoom of the user's: framed again on restore
   * (the window may have another size by then). Absent in views saved before it existed. */
  framed?: true;
}

export interface ShellView {
  page: ShellPage;
  /** The Map's active diagram (arch:root, a drilled level, a workflow). */
  diagramId: string | null;
  /** Camera of that diagram. */
  camera: Camera | null;
  drawerOpen: boolean;
  panelOpen: boolean;
  panelView: PanelViewName;
  panelWidth: number;
}

export const PANEL_MIN = 340;
export const PANEL_MAX = 720;
export const PANEL_DEFAULT = 420;

export const DEFAULT_SHELL_VIEW: ShellView = {
  page: "/map",
  diagramId: null,
  camera: null,
  drawerOpen: false,
  panelOpen: true,
  panelView: "agent",
  panelWidth: PANEL_DEFAULT,
};

export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return PANEL_DEFAULT;
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
}

export function isShellPage(v: unknown): v is ShellPage {
  return typeof v === "string" && (SHELL_PAGES as readonly string[]).includes(v);
}

export function isProjectPage(v: unknown): v is ProjectPage {
  return typeof v === "string" && (PROJECT_PAGES as readonly string[]).includes(v);
}

/** The page a location shows, as stored ("/" with ?view=project is the project dashboard). */
export function pageOf(pathname: string, search: Record<string, unknown> = {}): string {
  return pathname === "/" && search["view"] === "project" ? "/?view=project" : pathname;
}

/**
 * The page to store for a project: the current one when it is a project page, else the project
 * page stored before (a visit to Home or Settings does not replace it), else the map.
 */
export function projectPageToStore(current: string, previous: ShellView | null): ProjectPage {
  if (isProjectPage(current)) return current;
  if (previous && isProjectPage(previous.page)) return previous.page;
  return "/map";
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function readCamera(v: unknown): Camera | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<Record<"x" | "y" | "k" | "framed", unknown>>;
  if (!finite(c.x) || !finite(c.y) || !finite(c.k) || c.k <= 0 || c.k > 8) return null;
  return c.framed === true ? { x: c.x, y: c.y, k: c.k, framed: true } : { x: c.x, y: c.y, k: c.k };
}

const KEY = "shell";

/** Reads the shell's part of a stored view (null when there is none or it is unusable). */
export function decodeShellView(view: ViewState | null | undefined): ShellView | null {
  const raw = view?.[KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Partial<
    Record<"v" | "page" | "diagramId" | "camera" | "drawerOpen" | "panelOpen" | "panelView" | "panelWidth", unknown>
  >;
  if (v.v !== 1) return null;
  return {
    page: isShellPage(v.page) ? v.page : DEFAULT_SHELL_VIEW.page,
    diagramId: typeof v.diagramId === "string" && v.diagramId.length <= 512 ? v.diagramId : null,
    camera: readCamera(v.camera),
    drawerOpen: v.drawerOpen === true,
    panelOpen: v.panelOpen !== false,
    panelView: PANEL_VIEWS.includes(v.panelView as PanelViewName) ? (v.panelView as PanelViewName) : "agent",
    panelWidth: finite(v.panelWidth) ? clampPanelWidth(v.panelWidth) : PANEL_DEFAULT,
  };
}

/** Writes the shell's part into `base` (other keys kept). Rounded so tiny pans do not churn. */
export function encodeShellView(view: ShellView, base: ViewState | null = null): ViewState {
  const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    ...(base ?? {}),
    [KEY]: {
      v: 1,
      page: view.page,
      diagramId: view.diagramId,
      camera: view.camera
        ? {
            x: round(view.camera.x, 1),
            y: round(view.camera.y, 1),
            k: round(view.camera.k, 3),
            ...(view.camera.framed ? { framed: true } : {}),
          }
        : null,
      drawerOpen: view.drawerOpen,
      panelOpen: view.panelOpen,
      panelView: view.panelView,
      panelWidth: clampPanelWidth(view.panelWidth),
    },
  };
}

/** Same stored meaning (for skipping redundant saves). */
export function sameShellView(a: ShellView | null, b: ShellView | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(encodeShellView(a)) === JSON.stringify(encodeShellView(b));
}

/**
 * The page to open when entering a project: its saved project page (an app-wide page stored by an
 * older viewer counts as the map), unless the user asked for a page. `current` is pageOf(location).
 */
export function restorePage(saved: ShellView | null, current: string, explicit: boolean): ProjectPage | null {
  if (!saved || explicit) return null;
  const target = isProjectPage(saved.page) ? saved.page : "/map";
  if (target === current) return null;
  return target;
}
