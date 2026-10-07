import { VOICE_LINE_ATTRIBUTE, VOICEOVER_AUDIO_GROUP } from "@hyperframes/agent-protocol";
import { HF_AUDIO_GROUP_ATTR } from "@hyperframes/core/audio-groups";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import { measureVoiceoverCarve } from "../../components/editor/carveUnderVoiceover";
import { t } from "../../i18n";
import type { TimelineElement } from "../../player";
import {
  formatTimelineAttributeNumber,
  formatTimelineMediaOffset,
} from "../../player/components/timelineEditing";
import { insertGroupElement } from "../../hooks/timelineAudioGroupCreate";
import {
  buildPatchTarget,
  patchTimelineChangesInSource,
  type PersistTimelineBatchChange,
} from "../../hooks/timelineEditingHelpers";
import type {
  TimelineGroupCommitOptions,
  TimelineGroupMoveChange,
} from "../../hooks/useTimelineGroupEditing";
import { applyPatchByTarget } from "../../utils/sourcePatcher";
import { extendRootDurationInSource } from "../../utils/rootDuration";
import { saveProjectFilesWithHistory, type RecordEditInput } from "../../utils/studioFileHistory";
import { collectHtmlIds, getTimelineElementLabel } from "../../utils/studioHelpers";
import { generateId } from "../../utils/generateId";
import { deriveTimelineStoreKeyForDomId } from "../../player/lib/timelineElementHelpers";
import { patchVoiceClipSource, takeClipDuration } from "./voiceClipPatch";
import { resolveCarveAvailability, resolveVoiceLineTrack } from "./voicePlacement";
import {
  applyPlanToElements,
  planVoiceTakes,
  type SkippedVoiceLine,
  type TakeApplication,
} from "./voiceTakePlan";

/** The label the project's voiceover group is created with; the editing service writes the same one. */
export const VOICEOVER_GROUP_LABEL = "Voiceover";

/** Everything the voice clip writes need from Studio, so they run (and are tested) without React. */
export interface VoiceClipDeps {
  projectId: string;
  activeCompPath: string | null;
  elements: () => readonly TimelineElement[];
  rippleEnabled: () => boolean;
  playhead: () => number;
  readFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  /** Files a timeline edit is writing: the external-change watcher leaves them alone. */
  pendingEditPaths: Set<string>;
  groupMove: (
    changes: TimelineGroupMoveChange[],
    options?: TimelineGroupCommitOptions,
  ) => Promise<void>;
  setElements: (elements: TimelineElement[]) => void;
  /** Reloads the preview (and the SDK session) after a write. */
  refreshPreview: () => void;
  previewDocument: () => Document | null;
  /** A timeline clip's element in the preview document. */
  findNode: (element: TimelineElement) => Element | null;
  /** Selects the clip and scrolls the timeline to it. */
  reveal: (key: string) => void;
  /** The reason a timeline write is refused right now (an agent turn, a recording), or null. */
  blockedReason: () => string | null;
}

export interface VoiceApplyReport {
  /** Clips whose audio, in-point or length changed. */
  updated: number;
  /** Clips the ripple moved. */
  shifted: number;
  skipped: SkippedVoiceLine[];
  /** Labels of the locked later clips that made the ripple refuse the whole change (nothing was written). */
  blockedBy: string[];
  /** The lines the refusal kept on their clips' current take. */
  blockedLines: string[];
  /** The ripple could not be saved after the clips changed. */
  shiftFailed: boolean;
  /** Why nothing was written (refused or failed); null otherwise. */
  failure: string | null;
}

export interface VoiceAddReport {
  added: number;
  failure: string | null;
}

export type VoiceCarveReport =
  | { kind: "carved"; beds: number }
  | { kind: "no-voice" | "no-music" | "no-voices" | "unmeasurable" }
  | { kind: "failed"; message: string };

let gestureSequence = 0;

const keyOf = (element: TimelineElement) => element.key ?? element.id;
const pathOf = (deps: VoiceClipDeps, element: TimelineElement) =>
  element.sourceFile || deps.activeCompPath || "index.html";

function failureOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("voice.error.notSaved");
}

/**
 * Switches the clips of the lines to their selected takes: the file, the in-point and the length, and (ripple on)
 * the clips after them on the track, all in ONE undo entry. A locked clip is left as it is; a locked clip in the
 * way of the ripple refuses the whole change (nothing is written), like the delete ripple.
 */
export async function applyVoiceTakes(
  deps: VoiceClipDeps,
  applications: readonly TakeApplication[],
): Promise<VoiceApplyReport> {
  const none: VoiceApplyReport = {
    updated: 0,
    shifted: 0,
    skipped: [],
    blockedBy: [],
    blockedLines: [],
    shiftFailed: false,
    failure: null,
  };
  const blocked = deps.blockedReason();
  if (blocked !== null) return { ...none, failure: blocked };

  const elements = deps.elements();
  const plan = planVoiceTakes(elements, applications, {
    rippleEnabled: deps.rippleEnabled(),
    compositionPathOf: (element) => pathOf(deps, element),
  });
  if (plan.blockedBy.length > 0) {
    return {
      ...none,
      skipped: plan.skipped,
      blockedBy: plan.blockedBy.map(getTimelineElementLabel),
      blockedLines: plan.blockedLines,
    };
  }
  if (plan.clips.length === 0) return { ...none, skipped: plan.skipped };

  const coalesceKey = `voice-take:${gestureSequence++}`;
  const label = t("voice.history.applyTake");
  const touched = new Set<string>();
  const byPath = new Map<string, PersistTimelineBatchChange[]>();
  for (const clip of plan.clips) {
    const path = pathOf(deps, clip.element);
    const change: PersistTimelineBatchChange = {
      element: clip.element,
      buildPatches: (html, target) => {
        const next = patchVoiceClipSource(html, target, clip.attributes, clip.start);
        if (next !== html) touched.add(keyOf(clip.element));
        return next;
      },
    };
    byPath.set(path, [...(byPath.get(path) ?? []), change]);
  }

  try {
    await saveProjectFilesWithHistory({
      projectId: deps.projectId,
      label,
      coalesceKey,
      files: Object.fromEntries(
        [...byPath].map(([path, changes]) => [
          path,
          (original: string) => {
            const next = patchTimelineChangesInSource(original, path, changes);
            if (next !== original) deps.pendingEditPaths.add(path);
            return next;
          },
        ]),
      ),
      readFile: deps.readFile,
      writeFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
    });
  } catch (error) {
    return { ...none, skipped: plan.skipped, failure: failureOf(error) };
  }
  if (touched.size === 0) return { ...none, skipped: plan.skipped };

  let shifted = 0;
  let shiftFailed = false;
  if (plan.shifts.length > 0) {
    try {
      await deps.groupMove(plan.shifts, {
        coalesceKey,
        coalesceMs: Number.POSITIVE_INFINITY,
        label,
        suppressFailureToast: true,
      });
      shifted = plan.shifts.length;
    } catch (error) {
      shiftFailed = true;
      console.error("[Voice] ripple after a take change failed to persist", error);
    }
  }
  deps.setElements(applyPlanToElements(elements, plan, shifted > 0));
  deps.refreshPreview();
  return {
    updated: touched.size,
    shifted,
    skipped: plan.skipped,
    blockedBy: [],
    blockedLines: [],
    shiftFailed,
    failure: null,
  };
}

/**
 * Places lines on the timeline from the playhead, back to back, each on a free audio track (the voiceover's own first)
 * as a clip that speaks the line: `data-ov-voice-line`, the voiceover group, the take's file and range. One undo
 * entry, written through Studio's own path so Undo takes it back.
 */
export async function addVoiceLines(
  deps: VoiceClipDeps,
  items: readonly TakeApplication[],
): Promise<VoiceAddReport> {
  const blocked = deps.blockedReason();
  if (blocked !== null) return { added: 0, failure: blocked };
  const targetPath = deps.activeCompPath || "index.html";
  const inFile = deps.elements().filter((element) => pathOf(deps, element) === targetPath);

  let cursor = Number(formatTimelineAttributeNumber(deps.playhead()));
  const virtual: TimelineElement[] = [...inFile];
  const placed = items.flatMap(({ lineId, take }) => {
    const duration = takeClipDuration(take);
    if (duration <= 0) return [];
    const start = cursor;
    const track = resolveVoiceLineTrack(virtual, { start, duration });
    cursor = Number(formatTimelineAttributeNumber(start + duration));
    virtual.push({
      id: `placing-${lineId}`,
      tag: "audio",
      start,
      duration,
      track,
      authoredTrack: track,
      voiceLine: lineId,
      audioGroup: VOICEOVER_AUDIO_GROUP,
    });
    return [{ lineId, take, start, duration, track, hfId: `hf-${generateId()}` }];
  });
  if (placed.length === 0) return { added: 0, failure: null };

  const ids: string[] = [];
  try {
    await saveProjectFilesWithHistory({
      projectId: deps.projectId,
      label: t("voice.history.addLine"),
      files: {
        [targetPath]: (original: string) => {
          ids.length = 0;
          let source = original;
          let zIndex = Math.max(1, inFile.length + 1);
          for (const line of placed) {
            const id = buildTimelineAssetId(line.take.file, collectHtmlIds(source));
            ids.push(id);
            source = insertTimelineAssetIntoSource(
              source,
              buildTimelineAssetInsertHtml({
                id,
                hfId: line.hfId,
                assetPath: resolveTimelineAssetSrc(targetPath, line.take.file),
                kind: "audio",
                start: line.start,
                duration: line.duration,
                track: line.track,
                zIndex: zIndex++,
                mediaStart:
                  line.take.start > 0
                    ? Number(formatTimelineMediaOffset(line.take.start))
                    : undefined,
                attributes: {
                  [VOICE_LINE_ATTRIBUTE]: line.lineId,
                  [HF_AUDIO_GROUP_ATTR]: VOICEOVER_AUDIO_GROUP,
                },
              }),
            );
          }
          source = insertGroupElement(source, VOICEOVER_AUDIO_GROUP, VOICEOVER_GROUP_LABEL);
          deps.pendingEditPaths.add(targetPath);
          return extendRootDurationInSource(source, cursor);
        },
      },
      readFile: deps.readFile,
      writeFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
    });
  } catch (error) {
    return { added: 0, failure: failureOf(error) };
  }
  const first = ids[0];
  if (first !== undefined) deps.reveal(deriveTimelineStoreKeyForDomId(first, targetPath));
  deps.refreshPreview();
  return { added: placed.length, failure: null };
}

/**
 * Carves the music beds of the timeline against the voiceover group: the same measurement and the same filters and
 * envelopes the inspector's carve writes, for every bed, saved as one undo entry. An explicit action: nothing here
 * runs unless the user asked for it.
 */
export async function carveMusicUnderVoiceover(deps: VoiceClipDeps): Promise<VoiceCarveReport> {
  const blocked = deps.blockedReason();
  if (blocked !== null) return { kind: "failed", message: blocked };
  const availability = resolveCarveAvailability(deps.elements());
  if (availability.kind !== "ready") return { kind: availability.kind };
  const doc = deps.previewDocument();
  if (doc === null) return { kind: "unmeasurable" };

  const byPath = new Map<string, PersistTimelineBatchChange[]>();
  let carved = 0;
  let lastMiss: "no-voices" | "unmeasurable" = "no-voices";
  try {
    for (const bed of availability.beds) {
      const node = deps.findNode(bed);
      if (node === null || buildPatchTarget(bed) === null) continue;
      const measured = await measureVoiceoverCarve(doc, node, VOICEOVER_AUDIO_GROUP);
      if (measured.kind !== "carved") {
        lastMiss = measured.kind === "no-voices" ? "no-voices" : "unmeasurable";
        continue;
      }
      carved += 1;
      const path = pathOf(deps, bed);
      byPath.set(path, [
        ...(byPath.get(path) ?? []),
        {
          element: bed,
          buildPatches: (html, target) =>
            Object.entries(measured.attributes).reduce(
              (source, [attribute, value]) =>
                applyPatchByTarget(source, target, {
                  type: "attribute",
                  property: attribute,
                  value,
                }),
              html,
            ),
        },
      ]);
    }
    if (carved === 0) return { kind: lastMiss };
    await saveProjectFilesWithHistory({
      projectId: deps.projectId,
      label: t("voice.history.carve"),
      files: Object.fromEntries(
        [...byPath].map(([path, changes]) => [
          path,
          (original: string) => {
            const next = patchTimelineChangesInSource(original, path, changes);
            if (next !== original) deps.pendingEditPaths.add(path);
            return next;
          },
        ]),
      ),
      readFile: deps.readFile,
      writeFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
    });
  } catch (error) {
    return { kind: "failed", message: failureOf(error) };
  }
  deps.refreshPreview();
  return { kind: "carved", beds: carved };
}
