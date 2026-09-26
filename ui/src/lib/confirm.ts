// One app-wide confirmation dialog for actions started outside React state (a key press, a store
// call): `await confirmAction({...})` resolves true on confirm, false on cancel / Esc / a newer
// request. The dialog itself is components/shell/ConfirmHost.tsx (mounted once in the root).
import { useSyncExternalStore } from "react";

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  /** Red confirm button (deleting something). */
  destructive?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
}

let current: ConfirmRequest | null = null;
let resolveCurrent: ((ok: boolean) => void) | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // A newer request replaces an unanswered one (which counts as cancelled).
  resolveCurrent?.(false);
  return new Promise<boolean>((resolve) => {
    current = { ...options, id: nextId++ };
    resolveCurrent = resolve;
    emit();
  });
}

/** Answers the open request (the host calls this). */
export function settleConfirm(ok: boolean) {
  const resolve = resolveCurrent;
  current = null;
  resolveCurrent = null;
  emit();
  resolve?.(ok);
}

export function pendingConfirm(): ConfirmRequest | null {
  return current;
}

export function useConfirmRequest(): ConfirmRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
