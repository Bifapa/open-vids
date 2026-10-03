/**
 * The Asset Search policy is read by every view that mounts (Sources panel, Settings window) and kept in that view's
 * state. A change made elsewhere — the chat's "Turn on" on a permission card — announces itself here, so the views
 * that are mounted read the policy again instead of showing a stale switch.
 */
const listeners = new Set<() => void>();

/** Calls `listener` whenever the policy changed outside the view that holds it. Returns the unsubscribe. */
export function onAssetSearchPolicyChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceAssetSearchPolicyChanged(): void {
  for (const listener of [...listeners]) listener();
}
