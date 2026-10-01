import type {
  ApplyEditsResponse,
  EditorContext,
  PresetInfo,
  PresetKind,
  ProjectInventory,
  TimelineClip,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { EditingError, type RenderOutput } from "./host.js";

/** Everything the editing tools return is compact text for the model, capped at this many characters. */
export const RESULT_CHARS = 8_000;

const seconds = (value: number) => `${Number(value.toFixed(2))}`;

/** Joins lines while they fit in the budget; the count of dropped lines is reported so the model can narrow down. */
function fitLines(lines: string[], budget: number, noun: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length)
    kept.push(`… ${lines.length - kept.length} more ${noun} not shown`);
  return kept.join("\n");
}

function cap(text: string): string {
  return text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS - 1)}…`;
}

const cell = (value: string) => value.replace(/\s+/g, " ").replace(/\|/g, "/").trim();

function clipNotes(clip: TimelineClip): string {
  const notes: string[] = [];
  if (clip.mediaStart) notes.push(`in ${seconds(clip.mediaStart)}s`);
  if (clip.muted) notes.push("muted");
  else if (clip.volume !== null && clip.volume !== 1) notes.push(`vol ${seconds(clip.volume)}`);
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

export function formatTimelineTable(timeline: TimelineSnapshot, budget = 6_000): string {
  const head = `${timeline.composition.path} · ${timeline.composition.width}×${timeline.composition.height} · ${seconds(timeline.composition.duration)} s · ${timeline.clips.length} clips · version ${timeline.version}`;
  if (timeline.clips.length === 0) return `${head}\nThe timeline is empty.`;
  const clips = [...timeline.clips].sort((a, b) => a.track - b.track || a.start - b.start);
  return `${head}\n${CLIP_HEADER}\n${fitLines(clips.map(clipRow), budget, "clips")}`;
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
  if (selection.assetPath) parts.push(`selected asset ${selection.assetPath}`);
  if (selection.range) {
    parts.push(
      `selected range ${seconds(selection.range.start)}–${seconds(selection.range.end)} s`,
    );
  }
  if (selection.clips.length === 0 && !selection.assetPath && !selection.range) {
    parts.push("nothing selected");
  }
  const scope =
    context.activeComposition && context.activeComposition.path !== composition
      ? ` (this table shows ${composition})`
      : "";
  return `Editor state captured when the user sent the message (it may have changed since): ${parts.join("; ")}${scope}.`;
}

export function formatTimeline(timeline: TimelineSnapshot, context?: EditorContext): string {
  const blocks = [formatTimelineTable(timeline)];
  if (context) blocks.push(describeContext(context, timeline.composition.path));
  return cap(blocks.join("\n\n"));
}

export function formatEditResult(response: ApplyEditsResponse): string {
  const lines = response.results.map((result, index) => {
    const row = `${index + 1}. ${result.op}`;
    const many = result.clipIds;
    if (many !== undefined) {
      const count = `${many.length} ${many.length === 1 ? "clip" : "clips"}`;
      return result.op === "remove_clip"
        ? `${row}: removed ${count}`
        : `${row} → ${count}${many[0] ? ` (first ${many[0]})` : ""}`;
    }
    const created = result.newClipId
      ? `${result.clipId ?? "?"} → new clip ${result.newClipId}`
      : (result.clipId ?? "no clip");
    return `${row}: ${created}`;
  });
  const files =
    response.changedFiles.length > 0 ? response.changedFiles.join(", ") : "no files changed";
  const head = `Applied ${response.results.length} ${response.results.length === 1 ? "operation" : "operations"} (${files}). The Studio timeline and preview update by themselves.`;
  return cap(
    [
      head,
      fitLines(lines, 2_000, "results"),
      "Timeline now:",
      formatTimelineTable(response.timeline, 4_500),
    ].join("\n"),
  );
}

export function formatInventory(inventory: ProjectInventory): string {
  const compositions = inventory.compositions.map(
    (composition) =>
      `- ${composition.path}${composition.isMain ? " (main)" : ""} · ${composition.width}×${composition.height} · ${seconds(composition.duration)} s · ${composition.clipCount} clips`,
  );
  const assets = inventory.assets.map((asset) => {
    const details = [
      asset.kind,
      asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
      asset.duration !== null ? `${seconds(asset.duration)} s` : null,
      asset.kind === "video" && asset.hasAudio !== null
        ? asset.hasAudio
          ? "has audio"
          : "silent"
        : null,
    ].filter(Boolean);
    return `- ${asset.path} · ${details.join(" · ")}`;
  });
  const renders = inventory.renders.map(
    (render) => `- ${render.path} · ${(render.bytes / 1_000_000).toFixed(1)} MB`,
  );
  const sections = [
    `Compositions (${compositions.length}):\n${compositions.join("\n") || "none"}`,
    `Assets (${assets.length}):\n${fitLines(assets, 4_500, "assets") || "none"}`,
    `Renders (${renders.length}):\n${fitLines(renders, 1_000, "renders") || "none"}`,
  ];
  return cap(sections.join("\n\n"));
}

export function formatPresets(kind: PresetKind, presets: PresetInfo[]): string {
  if (presets.length === 0) return `No ${kind} presets match.`;
  const lines = presets.map((preset) => {
    const tags = preset.tags.length > 0 ? ` [${preset.tags.join(", ")}]` : "";
    const length = preset.duration !== null ? ` · ${seconds(preset.duration)} s` : "";
    return `- ${preset.name} — ${cell(preset.title)}${length}${tags}: ${cell(preset.description).slice(0, 160)}`;
  });
  const usage: Record<PresetKind, string> = {
    caption: "Use the name as `preset` in apply_captions.",
    block: "Use the name as `name` in add_component.",
    component: "Use the name as `name` in add_component.",
  };
  return cap(
    `${presets.length} ${kind} presets. ${usage[kind]}\n${fitLines(lines, 6_500, "presets")}`,
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
