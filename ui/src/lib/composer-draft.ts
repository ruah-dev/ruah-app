// Put text into the agent composer without sending it ("Draft an issue with the agent").
// The composer may not be mounted yet (the side panel switches views first), so the text is
// parked here and taken by whichever Composer mounts or is listening.
const EVENT = "ruah:composer-draft";
let pending: string | null = null;

export function requestComposerDraft(text: string) {
  pending = text;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Returns the parked draft once (null when there is none). */
export function takeComposerDraft(): string | null {
  const t = pending;
  pending = null;
  return t;
}

export function onComposerDraft(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
