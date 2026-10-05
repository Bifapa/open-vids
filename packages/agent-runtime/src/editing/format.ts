import type {
  ApplyEditsResponse,
  AssetKind,
  AssetRange,
  EditOperationResult,
  EditorContext,
  PresetKind,
  ProjectInventory,
  TimelineClip,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { EditingError, type PresetPage, type RenderOutput } from "./host.js";
import { describePreviewElement } from "../promptContext.js";

/** Everything the editing tools return is compact text for the model, capped at this many characters. */
export const RESULT_CHARS = 8_000;

const seconds = (value: number) => `${Number(value.toFixed(2))}`;

/** The lines that fit in the budget, in order (at least none past it). */
function takeLines(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

/** Joins lines while they fit in the budget; the count of dropped lines is reported so the model can narrow down. */
function fitLines(lines: string[], budget: number, noun: string, hint = ""): string {
  const kept = takeLines(lines, budget);
  if (kept.length < lines.length)
    kept.push(`… ${lines.length - kept.length} more ${noun} not shown${hint}`);
  return kept.join("\n");
}

function cap(text: string): string {
  return text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS - 1)}…`;
}

const cell = (value: string) => value.replace(/\s+/g, " ").replace(/\|/g, "/").trim();

function clipNotes(clip: TimelineClip): string {
  const notes: string[] = [];
  if (clip.mediaStart) notes.push(`in ${seconds(clip.mediaStart)}s`);
  if (clip.playbackRate !== undefined) notes.push(`speed ${seconds(clip.playbackRate)}×`);
  if (clip.muted) notes.push("muted");
  else if (clip.volume !== null && clip.volume !== 1) notes.push(`vol ${seconds(clip.volume)}`);
  if (clip.opacity !== undefined) notes.push(`opacity ${seconds(clip.opacity)}`);
  if (clip.colorGrade !== undefined) notes.push(`graded ${clip.colorGrade}`);
  if (clip.audioFx !== undefined) notes.push(`fx ×${clip.audioFx}`);
  if (clip.automation !== undefined) notes.push(`automated ${clip.automation.join("+")}`);
  if (clip.locked) notes.push("locked");
  if (clip.placeholder) notes.push("(template placeholder — not user content)");
  if (clip.provenance?.storyNode) notes.push(`story ${clip.provenance.storyNode}`);
  if (clip.provenance?.cut) notes.push(`cut ${clip.provenance.cut}`);
  return notes.join(", ");
}

function clipRow(clip: TimelineClip): string {
  const source = clip.src ?? clip.compositionSrc ?? "";
  return [
    clip.id,
    clip.kind,
    cell(clip.label).slice(0, 40),
    `${seconds(clip.start)}–${seconds(clip.end)}`,
    String(clip.track),
    source,
    clipNotes(clip),
  ].join(" | ");
}

const CLIP_HEADER = "id | kind | label | start–end (s) | track | src | notes";

/** Which clips `inspect_timeline` lists: a track, a time window (clips that overlap it), and a page of the matches. */
export interface TimelineFilter {
  track?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

function describeFilter(filter: TimelineFilter): string {
  const parts: string[] = [];
  if (filter.track !== undefined) parts.push(`track ${filter.track}`);
  if (filter.from !== undefined) parts.push(`from ${seconds(filter.from)} s`);
  if (filter.to !== undefined) parts.push(`to ${seconds(filter.to)} s`);
  return parts.join(", ");
}

export function formatTimelineTable(
  timeline: TimelineSnapshot,
  budget = 6_000,
  filter: TimelineFilter = {},
): string {
  const total = timeline.clips.length;
  const head = `${timeline.composition.path} · ${timeline.composition.width}×${timeline.composition.height} · ${seconds(timeline.composition.duration)} s · ${total} clips · version ${timeline.version}`;
  if (total === 0) return `${head}\nThe timeline is empty.`;
  const matching = [...timeline.clips]
    .sort((a, b) => a.track - b.track || a.start - b.start)
    .filter(
      (clip) =>
        (filter.track === undefined || clip.track === filter.track) &&
        (filter.from === undefined || clip.end > filter.from) &&
        (filter.to === undefined || clip.start < filter.to),
    );
  const offset = Math.min(filter.offset ?? 0, matching.length);
  const window = matching.slice(
    offset,
    filter.limit === undefined ? undefined : offset + filter.limit,
  );
  const shown = takeLines(window.map(clipRow), budget);
  const scope = describeFilter(filter);
  const lead = scope ? `${head}\n${matching.length} of ${total} clips match (${scope})` : head;
  if (matching.length === 0) return `${lead}\nNo clip matches.`;
  const after = matching.length - offset - shown.length;
  const range = `clips ${offset + 1}–${offset + shown.length} of ${matching.length}`;
  const tail =
    after > 0
      ? `… ${after} more clips; call inspect_timeline again with offset=${offset + shown.length} (and track/from/to to narrow it)`
      : "";
  return [
    lead,
    ...(offset > 0 || after > 0 ? [range] : []),
    CLIP_HEADER,
    ...shown,
    ...(tail ? [tail] : []),
  ].join("\n");
}

function describeContext(context: EditorContext, composition: string): string {
  const parts: string[] = [];
  if (context.activeComposition) parts.push(`active composition ${context.activeComposition.path}`);
  parts.push(
    `playhead ${seconds(context.playhead.time)} s (${context.playhead.playing ? "playing" : "paused"})`,
  );
  const { selection } = context;
  if (selection.clips.length > 0) {
    parts.push(
      `selected clips ${selection.clips.map((clip) => clip.hfId ?? clip.domId ?? clip.id).join(", ")}`,
    );
  }
  if (selection.previewElement) {
    parts.push(`selected canvas element ${describePreviewElement(selection.previewElement)}`);
  }
  if (selection.assetPath) parts.push(`selected asset ${selection.assetPath}`);
  if (selection.range) {
    parts.push(
      `selected range ${seconds(selection.range.start)}–${seconds(selection.range.end)} s`,
    );
  }
  if (
    selection.clips.length === 0 &&
    !selection.previewElement &&
    !selection.assetPath &&
    !selection.range
  ) {
    parts.push("nothing selected");
  }
  const scope =
    context.activeComposition && context.activeComposition.path !== composition
      ? ` (this table shows ${composition})`
      : "";
  return `Editor state captured when the user sent the message (it may have changed since): ${parts.join("; ")}${scope}.`;
}

export function formatTimeline(
  timeline: TimelineSnapshot,
  context?: EditorContext,
  filter: TimelineFilter = {},
): string {
  const blocks = [formatTimelineTable(timeline, 6_000, filter)];
  if (context) blocks.push(describeContext(context, timeline.composition.path));
  return cap(blocks.join("\n\n"));
}

function describeResult(result: EditOperationResult, index: number): string {
  const row = `${index + 1}. ${result.op}`;
  const note = result.note ? ` — ${result.note}` : "";
  const many = result.clipIds;
  if (many !== undefined) {
    const count = `${many.length} ${many.length === 1 ? "clip" : "clips"}`;
    return result.op === "remove_clip"
      ? `${row}: removed ${count}${note}`
      : `${row} → ${count}${many[0] ? ` (first ${many[0]})` : ""}${note}`;
  }
  const created = result.newClipId
    ? `${result.clipId ?? "?"} → new clip ${result.newClipId}`
    : (result.clipId ?? "no clip");
  return `${row}: ${created}${note}`;
}

export function formatWarnings(warnings: readonly string[] | undefined): string[] {
  return warnings && warnings.length > 0
    ? ["Warnings:", ...warnings.map((warning) => `- ${warning}`)]
    : [];
}

export function formatEditResult(response: ApplyEditsResponse): string {
  const lines = response.results.map(describeResult);
  const files =
    response.changedFiles.length > 0 ? response.changedFiles.join(", ") : "no files changed";
  const head = response.replayed
    ? `Studio had already applied this exact batch and the project is unchanged since, so nothing was applied again; this is the stored result (${response.results.length} ${response.results.length === 1 ? "operation" : "operations"}, ${files}).`
    : `Applied ${response.results.length} ${response.results.length === 1 ? "operation" : "operations"} (${files}). The Studio timeline and preview update by themselves.`;
  return cap(
    [
      head,
      fitLines(lines, 2_000, "results"),
      ...formatWarnings(response.warnings),
      "Timeline now:",
      formatTimelineTable(response.timeline, 4_500),
    ].join("\n"),
  );
}

/**
 * The inventory note for a video/audio asset the user picked a fragment of: everything the AI may use is inside it.
 * Null when the whole file may be used.
 */
function pickedFragment(range: AssetRange | undefined): string | null {
  if (!range) return null;
  return `USER-PICKED FRAGMENT ${seconds(range.start)}–${seconds(range.end)} s (${seconds(range.end - range.start)} s): use only this part`;
}

/** Which assets `inspect_project` lists: a text in the path, a kind, and a page of the matches. */
export interface InventoryFilter {
  query?: string | undefined;
  kind?: AssetKind | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export function formatInventory(inventory: ProjectInventory, filter: InventoryFilter = {}): string {
  const compositions = inventory.compositions.map(
    (composition) =>
      `- ${composition.path}${composition.isMain ? " (main)" : ""} · ${composition.width}×${composition.height} · ${seconds(composition.duration)} s · ${composition.clipCount} clips`,
  );
  const query = filter.query?.toLowerCase();
  const matching = inventory.assets.filter(
    (asset) =>
      (filter.kind === undefined || asset.kind === filter.kind) &&
      (query === undefined || asset.path.toLowerCase().includes(query)),
  );
  const offset = Math.min(filter.offset ?? 0, matching.length);
  const window = matching.slice(
    offset,
    filter.limit === undefined ? undefined : offset + filter.limit,
  );
  const assets = window.map((asset) => {
    const details = [
      asset.kind,
      asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
      asset.duration !== null ? `${seconds(asset.duration)} s` : null,
      asset.kind === "video" && asset.hasAudio !== null
        ? asset.hasAudio
          ? "has audio"
          : "silent"
        : null,
      pickedFragment(asset.range),
    ].filter(Boolean);
    return `- ${asset.path} · ${details.join(" · ")}`;
  });
  const renders = inventory.renders.map(
    (render) => `- ${render.path} · ${(render.bytes / 1_000_000).toFixed(1)} MB`,
  );
  const shownAssets = takeLines(assets, 4_500);
  const next = offset + shownAssets.length;
  const scope = [filter.kind, filter.query ? `"${filter.query}"` : null].filter(Boolean).join(", ");
  const assetTitle =
    scope || offset > 0
      ? `Assets (${matching.length} of ${inventory.assets.length}${scope ? ` match ${scope}` : ""})`
      : `Assets (${assets.length})`;
  const moreAssets =
    next < matching.length
      ? `\n… ${matching.length - next} more assets; call inspect_project again with offset=${next} (or narrow it with query/kind)`
      : "";
  const sections = [
    `Compositions (${compositions.length}):\n${compositions.join("\n") || "none"}`,
    `${assetTitle}:\n${shownAssets.join("\n") || "none"}${moreAssets}`,
    `Renders (${renders.length}):\n${fitLines(renders, 1_000, "renders") || "none"}`,
  ];
  return cap(sections.join("\n\n"));
}

export function formatPresets(kind: PresetKind, page: PresetPage, offset = 0): string {
  const { presets, total } = page;
  if (presets.length === 0) {
    return offset > 0 && total > 0
      ? `No ${kind} presets from offset ${offset}: only ${total} match.`
      : `No ${kind} presets match.`;
  }
  const lines = presets.map((preset) => {
    const tags = preset.tags.length > 0 ? ` [${preset.tags.join(", ")}]` : "";
    const length = preset.duration !== null ? ` · ${seconds(preset.duration)} s` : "";
    return `- ${preset.name} — ${cell(preset.title)}${length}${tags}: ${cell(preset.description).slice(0, 160)}`;
  });
  const usage: Record<PresetKind, string> = {
    caption: "Use the name as `preset` in apply_captions or captions_from_transcript.",
    block: "Use the name as `name` in add_component (transitions and graphics are blocks).",
    component: "Use the name as `name` in add_component.",
    color_grade: "Use the name as `preset` in set_color_grade.",
    audio_fx: "Use the name as `preset` in set_audio_fx.",
  };
  const shown = takeLines(lines, 6_500);
  const next = offset + shown.length;
  const more =
    next < total
      ? `\n… ${total - next} more ${kind} presets; call browse_presets again with offset=${next} (or narrow it with query)`
      : "";
  return cap(
    `${total} ${kind} presets${offset > 0 || next < total ? ` (showing ${offset + 1}–${next})` : ""}. ${usage[kind]}\n${shown.join("\n")}${more}`,
  );
}

export function formatRender(output: RenderOutput): string {
  const details = [
    `${seconds(output.duration)} s`,
    `${output.width}×${output.height}`,
    output.videoCodec,
    `${(output.bytes / 1_000_000).toFixed(1)} MB`,
    output.hasAudio === false ? "no audio" : null,
  ].filter(Boolean);
  return `Rendered ${output.path} (${details.join(", ")}). The file is saved in the project's renders folder.`;
}

/** What the model sees for a failed call: a stable code, the message, and the failing operation of a batch. */
export function formatError(error: EditingError): string {
  const where = error.opIndex !== undefined ? ` (operations[${error.opIndex}])` : "";
  return `${error.code}${where}: ${error.message}`;
}
