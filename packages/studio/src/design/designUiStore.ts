import { create } from "zustand";
import type { DesignSourceKind } from "@hyperframes/agent-protocol";
import type { DesignPreviewTarget } from "./designClient";

/**
 * The modal of the design surface. The header's popover only asks for one; `DesignHost`, mounted with the agent
 * store beside the chat, shows it (starting a turn needs the agent).
 */
export type DesignDialog =
  | { kind: "create"; source: DesignSourceKind }
  | { kind: "edit"; systemId: string }
  | { kind: "preview"; target: DesignPreviewTarget; title: string };

interface DesignUiState {
  dialog: DesignDialog | null;
  /** The "Create design system" dialog, on `source` (a brief by default). */
  openCreate(source?: DesignSourceKind): void;
  /** "Edit with the agent" for one library system. */
  openEdit(systemId: string): void;
  openPreview(target: DesignPreviewTarget, title: string): void;
  close(): void;
}

export const useDesignUi = create<DesignUiState>((set) => ({
  dialog: null,
  openCreate: (source = "scratch") => set({ dialog: { kind: "create", source } }),
  openEdit: (systemId) => set({ dialog: { kind: "edit", systemId } }),
  openPreview: (target, title) => set({ dialog: { kind: "preview", target, title } }),
  close: () => set({ dialog: null }),
}));
