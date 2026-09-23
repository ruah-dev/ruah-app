// Tiny UI signal bus for global shortcuts that target a component deep in the tree
// (⌘. opens the agent · model picker of the mounted composer).
type Listener = () => void;

const pickerListeners: Listener[] = [];
let pickerPending = false;

/** The composer that owns keyboard shortcuts registers here. Last registered wins. */
export function onModelPickerRequest(listener: Listener): () => void {
  pickerListeners.push(listener);
  return () => {
    const i = pickerListeners.lastIndexOf(listener);
    if (i >= 0) pickerListeners.splice(i, 1);
  };
}

/** Returns false when no composer is mounted; the request stays pending until one mounts. */
export function requestModelPicker(): boolean {
  const l = pickerListeners[pickerListeners.length - 1];
  if (l) {
    l();
    return true;
  }
  pickerPending = true;
  return false;
}

export function consumeModelPickerRequest(): boolean {
  const p = pickerPending;
  pickerPending = false;
  return p;
}
