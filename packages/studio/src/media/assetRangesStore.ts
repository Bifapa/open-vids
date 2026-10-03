/**
 * The project's picked fragments (`.hyperframes/media/ranges.json`) as the Studio sees them. One store feeds the
 * Media workspace, the Edit workspace's asset list and the timeline drop; it follows the open project.
 *
 * The file is history-tracked but not part of the preview signature, so no file-change event announces it: the store
 * reloads on what can have moved it: the window coming back into focus (another window, a hand edit), a history step
 * (`refreshAssetRanges`: undo, redo, an agent revert), and being opened.
 */

import { useEffect } from "react";
import { create } from "zustand";
import type { AssetRange } from "@hyperframes/agent-protocol";
import { mediaClient } from "./mediaClient";

interface RangesState {
  projectId: string | null;
  ranges: ReadonlyMap<string, AssetRange>;
  /** The answer of the server (or the inventory) is in; before that a missing range means "not known yet". */
  loaded: boolean;
}

export const assetRangesStore = create<RangesState>(() => ({
  projectId: null,
  ranges: new Map(),
  loaded: false,
}));

/** One reload for a burst of signals (focus and visibility fire together). */
const RELOAD_DELAY_MS = 150;

let generation = 0;
let reloadTimer: number | undefined;
let holders = 0;

const toMap = (ranges: Record<string, AssetRange>) =>
  new Map(
    Object.entries(ranges).map(([path, range]) => [path, { start: range.start, end: range.end }]),
  );

async function reloadNow(projectId: string): Promise<void> {
  const mine = ++generation;
  const view = await mediaClient.ranges(projectId).catch(() => null);
  if (!view || mine !== generation || assetRangesStore.getState().projectId !== projectId) return;
  assetRangesStore.setState({ ranges: toMap(view.ranges), loaded: true });
}

/** Reloads soon: callers that know the stored picks may have moved (a history step). */
export function refreshAssetRanges(): void {
  const { projectId } = assetRangesStore.getState();
  if (!projectId) return;
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => void reloadNow(projectId), RELOAD_DELAY_MS);
}

function openProject(projectId: string): void {
  if (assetRangesStore.getState().projectId === projectId) return;
  generation += 1;
  assetRangesStore.setState({ projectId, ranges: new Map(), loaded: false });
  void reloadNow(projectId);
}

const onFocus = () => refreshAssetRanges();
const onVisibility = () => {
  if (document.visibilityState === "visible") refreshAssetRanges();
};

/**
 * Keeps the store following `projectId` while the caller is mounted. The reload signals are attached while anyone
 * holds the store.
 */
export function useAssetRanges(projectId: string): ReadonlyMap<string, AssetRange> {
  useEffect(() => {
    openProject(projectId);
    // A project opened earlier may have been changed behind the store's back since it was last held.
    refreshAssetRanges();
    holders += 1;
    if (holders === 1) {
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      holders -= 1;
      if (holders === 0) {
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
        window.clearTimeout(reloadTimer);
      }
    };
  }, [projectId]);
  return assetRangesStore((state) => (state.projectId === projectId ? state.ranges : EMPTY));
}

const EMPTY: ReadonlyMap<string, AssetRange> = new Map();

/** The picked fragment of one asset, for a badge: null when none (or not loaded). */
export function useAssetRange(path: string): AssetRange | null {
  return assetRangesStore((state) => state.ranges.get(path) ?? null);
}

let saveSequence = 0;

/**
 * Stores (or, with null, clears) the pick of an asset. The new value shows at once; the server's answer (it clamps)
 * replaces it, and a failure restores what the server holds before throwing.
 */
export async function saveAssetRange(
  projectId: string,
  path: string,
  range: AssetRange | null,
): Promise<AssetRange | null> {
  const mine = ++saveSequence;
  generation += 1;
  const state = assetRangesStore.getState();
  if (state.projectId === projectId) {
    const next = new Map(state.ranges);
    if (range) next.set(path, range);
    else next.delete(path);
    assetRangesStore.setState({ ranges: next });
  }
  try {
    const view = await mediaClient.setRange(projectId, path, range);
    if (mine === saveSequence && assetRangesStore.getState().projectId === projectId) {
      generation += 1;
      assetRangesStore.setState({ ranges: toMap(view.ranges), loaded: true });
    }
    return view.ranges[path] ?? null;
  } catch (error) {
    if (assetRangesStore.getState().projectId === projectId) void reloadNow(projectId);
    throw error;
  }
}
