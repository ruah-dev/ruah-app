// Last map camera (pan / zoom) per diagram of the open project, outside React: the canvas writes it
// on every move, the shell saves it into the per-project view state (§13.5) and seeds it back when
// a project is entered, so a level reopens where it was left.
export interface Camera {
  x: number;
  y: number;
  k: number;
  /** The canvas framed the level itself (Fit to view); re-framed at another size. */
  framed?: true;
}

const cameras = new Map<string, Camera>();
const listeners = new Set<() => void>();
const moveListeners = new Set<() => void>();
let moveTimer: ReturnType<typeof setTimeout> | undefined;
const MOVE_SETTLE_MS = 800;

export function rememberCamera(diagramId: string, cam: Camera) {
  cameras.set(diagramId, cam);
  if (moveListeners.size === 0) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    for (const l of moveListeners) l();
  }, MOVE_SETTLE_MS);
}

/** Called once the camera has been still for a moment after moving (to save it). */
export function onCameraSettled(fn: () => void): () => void {
  moveListeners.add(fn);
  return () => moveListeners.delete(fn);
}

export function recallCamera(diagramId: string): Camera | undefined {
  return cameras.get(diagramId);
}

/** A project was entered: forget the previous project's cameras, optionally seeding one. */
export function resetCameras(seed?: { diagramId: string; camera: Camera } | null) {
  cameras.clear();
  if (seed) cameras.set(seed.diagramId, seed.camera);
  for (const l of listeners) l();
}

/** The canvas re-applies its saved camera when the shell seeds a new one. */
export function onCamerasReset(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
