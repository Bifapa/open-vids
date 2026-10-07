import { isEditError, type ApplyEditsRequest } from "@hyperframes/agent-protocol";
import { t } from "../../i18n";
import { buildProjectApiPath } from "../../utils/projectRouting";
import { serializeStudioFileMutations } from "../../utils/studioFileMutationCoordinator";
import { isCaptionsApplyAnswer, type CaptionsApplyAnswer } from "../voiceGuards";
import type { VoiceClipDeps } from "./voiceClipOps";

export type VoiceCaptionsReport =
  | { kind: "added"; files: number; skipped: number }
  | { kind: "failed"; message: string };

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("voice.error.notSaved");
}

/** `POST /editing/apply`: the server's own editing service, the one agents write through. */
async function applyOnServer(
  projectId: string,
  request: ApplyEditsRequest,
): Promise<CaptionsApplyAnswer> {
  const response = await fetch(buildProjectApiPath(projectId, "/editing/apply"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    throw new Error(isEditError(error) ? error.message : t("voice.error.notSaved"));
  }
  if (!isCaptionsApplyAnswer(body)) throw new Error(t("voice.error.notSaved"));
  return body;
}

/** A project file's content, or "" for one that does not exist yet (a captions file the write creates). */
async function contentOrEmpty(deps: VoiceClipDeps, path: string): Promise<string> {
  try {
    return await deps.readFile(path);
  } catch {
    return "";
  }
}

/**
 * Writes captions from the voiceover clips of the active composition with the editing service's
 * `captions_from_voiceover` (each line's own text timed by its take's words), and records them as ONE undo entry.
 *
 * The write is the server's, not Studio's: a dry run names the files it will touch, their content is read, the batch
 * is applied for real, and the files are then claimed in the project history under the user's own label. The
 * server's write reaches the preview as any outside change does (the external-change watcher reloads it), so the
 * preview and the timeline follow without a second reload here.
 */
export async function addVoiceCaptions(deps: VoiceClipDeps): Promise<VoiceCaptionsReport> {
  const blocked = deps.blockedReason();
  if (blocked !== null) return { kind: "failed", message: blocked };
  const composition = deps.activeCompPath || "index.html";
  const request: ApplyEditsRequest = {
    composition,
    operations: [{ op: "captions_from_voiceover" }],
  };
  try {
    const plan = await applyOnServer(deps.projectId, { ...request, dryRun: true });
    const paths = plan.changedFiles;
    if (paths.length === 0) return { kind: "added", files: 0, skipped: plan.warnings?.length ?? 0 };
    return await serializeStudioFileMutations(deps.writeProjectFile, paths, async () => {
      const before = new Map<string, string>();
      for (const path of paths) before.set(path, await contentOrEmpty(deps, path));
      const done = await applyOnServer(deps.projectId, request);
      const files: Record<string, { before: string; after: string }> = {};
      for (const path of done.changedFiles) {
        files[path] = {
          before: before.get(path) ?? (await contentOrEmpty(deps, path)),
          after: await contentOrEmpty(deps, path),
        };
      }
      await deps.recordEdit({ label: t("voice.history.addCaptions"), files });
      return {
        kind: "added" as const,
        files: done.changedFiles.length,
        skipped: done.warnings?.length ?? 0,
      };
    });
  } catch (error) {
    return { kind: "failed", message: describe(error) };
  }
}
