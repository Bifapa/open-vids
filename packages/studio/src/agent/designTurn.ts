import type {
  DesignActionOptions,
  EditorContext,
  StartTurnRequest,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";

/**
 * What the user chose for a design turn. `create` carries its source; `edit` the library system it changes and the
 * change asked for. Free text is the brief (`scratch`), notes for the other sources, or the edit instruction.
 */
export type DesignTurnSpec =
  | { action: "create"; source: "scratch"; brief: string }
  | { action: "create"; source: "project"; notes?: string }
  | { action: "create"; source: "video"; video: string; notes?: string }
  | { action: "create"; source: "website"; url: string; notes?: string }
  | {
      action: "create";
      source: "external_project";
      projectKey: string;
      projectName: string;
      notes?: string;
    }
  | { action: "edit"; systemId: string; instruction: string };

/** The prompt the chat shows for the turn: what was asked, in the user's language; the options carry the rest. */
function promptOf(spec: DesignTurnSpec): string {
  if (spec.action === "edit") return spec.instruction.trim();
  if (spec.source === "scratch") return spec.brief.trim();
  let lead: string;
  switch (spec.source) {
    case "project":
      lead = t("studio.design.prompt.project");
      break;
    case "video":
      lead = t("studio.design.prompt.video", { video: spec.video });
      break;
    case "website":
      lead = t("studio.design.prompt.website", { url: spec.url });
      break;
    case "external_project":
      lead = t("studio.design.prompt.externalProject", { name: spec.projectName });
      break;
  }
  const notes = spec.notes?.trim();
  return notes ? `${lead}\n\n${notes}` : lead;
}

function optionsOf(spec: DesignTurnSpec): DesignActionOptions {
  if (spec.action === "edit") return { systemId: spec.systemId };
  switch (spec.source) {
    case "scratch":
    case "project":
      return { source: spec.source };
    case "video":
      return { source: "video", video: spec.video };
    case "website":
      return { source: "website", url: spec.url };
    case "external_project":
      return { source: "external_project", projectKey: spec.projectKey };
  }
}

/** The design turn a design surface starts: the chat's own mode and intent (design turns always edit). */
export function designTurnRequest(
  spec: DesignTurnSpec,
  editorContext: EditorContext | undefined,
  userLanguage?: string,
): StartTurnRequest {
  return {
    prompt: promptOf(spec),
    designAction: spec.action,
    designOptions: optionsOf(spec),
    editorContext,
    ...(userLanguage && { userLanguage }),
  };
}
