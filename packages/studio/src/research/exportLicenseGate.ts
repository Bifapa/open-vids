/**
 * The license check in front of every export. `useRenderQueue.startRender` (which every Export control goes
 * through) asks the server what the export would ship; when researched assets with an unknown or restricted license
 * are in it, it waits here for the user's decision. The check only warns: "Export anyway" always proceeds, and a
 * check that fails or has nothing to say never stands in the way.
 */

import { create } from "zustand";
import type { ExportLicenseCheck } from "@hyperframes/agent-protocol";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import type { ResearchClient } from "./researchClient";

/** `export`: go on; `review`: open the Sources panel instead; `cancel`: do nothing. */
export type ExportDecision = "export" | "review" | "cancel";

interface ExportLicenseGateState {
  /** The check waiting for the user, shown by `ExportLicenseDialog`. */
  pending: ExportLicenseCheck | null;
  decide(decision: ExportDecision): void;
}

let resolvePending: ((decision: ExportDecision) => void) | null = null;

export const useExportLicenseGate = create<ExportLicenseGateState>()((set) => ({
  pending: null,
  decide(decision) {
    const resolve = resolvePending;
    resolvePending = null;
    set({ pending: null });
    resolve?.(decision);
  },
}));

/** Shows the warnings and resolves with the user's decision; a newer question cancels an unanswered one. */
export function askExportDecision(check: ExportLicenseCheck): Promise<ExportDecision> {
  resolvePending?.("cancel");
  // A plain executor, not Promise.withResolvers: the WebKit of macOS 11, the minimum OS, predates it.
  return new Promise<ExportDecision>((resolve) => {
    resolvePending = resolve;
    useExportLicenseGate.setState({ pending: check });
  });
}

/**
 * True when the export may start. A check that fails (an older server, a network error) or has no warnings lets it
 * start unchanged; "Review sources" brings the Sources panel forward and does not export.
 */
export async function confirmExportLicenses(
  client: ResearchClient,
  projectId: string,
  composition: string | null,
): Promise<boolean> {
  let check: ExportLicenseCheck;
  try {
    check = await client.exportCheck(projectId, composition);
  } catch {
    return true;
  }
  if (check.warnings.length === 0) return true;
  const decision = await askExportDecision(check);
  if (decision === "review") useDockLayoutStore.getState().activatePanel("sources");
  return decision === "export";
}
