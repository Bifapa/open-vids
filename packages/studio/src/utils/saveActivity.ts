import { create } from "zustand";

interface SaveActivityState {
  /** Project-file writes in flight right now. */
  pending: number;
}

/** How many project-file saves are in flight, for the titlebar's Saved / Saving… state. */
export const useSaveActivityStore = create<SaveActivityState>(() => ({ pending: 0 }));

/** Counts `work` as an in-flight save until it settles, whether it lands or fails. */
export async function trackProjectSave<T>(work: () => Promise<T>): Promise<T> {
  useSaveActivityStore.setState((state) => ({ pending: state.pending + 1 }));
  try {
    return await work();
  } finally {
    useSaveActivityStore.setState((state) => ({ pending: Math.max(0, state.pending - 1) }));
  }
}
