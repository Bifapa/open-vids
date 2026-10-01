/**
 * The Media workspace's model: one item per project media file (and per researched file that went missing), with its
 * probe facts, analysis state, research provenance and usage folded in, plus the collection / analysis / search /
 * sort rules the browser applies. Pure — unit-tested.
 */

import type {
  ProjectAsset,
  ProjectSourceEntry,
  SourceAnalysisStatus,
  StageState,
  TranscriptSentence,
  VisionNote,
} from "@hyperframes/agent-protocol";
import { AUDIO_EXT, FONT_EXT, IMAGE_EXT, VIDEO_EXT } from "@hyperframes/core/media-types";
import { formatBytes, t, type TranslationKey } from "../i18n";

export type MediaKind = "video" | "image" | "audio" | "font";
export type MediaOrigin = "imported" | "research" | "download";

export interface MediaItem {
  /** Project-relative path. */
  path: string;
  /** File name with its extension. */
  name: string;
  kind: MediaKind;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  origin: MediaOrigin;
  provenance: ProjectSourceEntry | null;
  /** A researched file whose bytes are gone from the project. */
  offline: boolean;
  used: boolean;
  analysis: SourceAnalysisStatus | null;
}

export const KIND_ORDER: readonly MediaKind[] = ["video", "image", "audio", "font"];
export const KIND_LABELS = {
  video: "media.kind.video",
  image: "media.kind.image",
  audio: "media.kind.audio",
  font: "media.kind.font",
} as const satisfies Record<MediaKind, TranslationKey>;

/** One file's kind (`Image`), where `KIND_LABELS` names the group (`Images`). */
export const KIND_SINGULAR_LABELS = {
  video: "media.kindSingular.video",
  image: "media.kindSingular.image",
  audio: "media.kindSingular.audio",
  font: "media.kindSingular.font",
} as const satisfies Record<MediaKind, TranslationKey>;

export function mediaKindOf(path: string): MediaKind | null {
  if (VIDEO_EXT.test(path)) return "video";
  if (IMAGE_EXT.test(path)) return "image";
  if (AUDIO_EXT.test(path)) return "audio";
  if (FONT_EXT.test(path)) return "font";
  return null;
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function fileExtension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

function originOf(provenance: ProjectSourceEntry | null): MediaOrigin {
  if (!provenance) return "imported";
  return provenance.retrievedBy.agent === "user" ? "download" : "research";
}

function kindOfResearch(record: ProjectSourceEntry): MediaKind {
  if (record.mediaKind === "picture") return "image";
  return record.mediaKind;
}

export interface MediaSources {
  /** The project's asset paths (the file tree's media and fonts). */
  assets: readonly string[];
  /** Probe facts from the editing inventory, by path. */
  inventory: ReadonlyMap<string, ProjectAsset>;
  analysis: ReadonlyMap<string, SourceAnalysisStatus>;
  provenance: readonly ProjectSourceEntry[];
  /** Paths the open timeline or the Story Graph uses. */
  usedPaths: ReadonlySet<string>;
}

/**
 * The library is the project's source media: renders (`renders/`) and Studio's own files (`.hyperframes/` QA frames,
 * analysis caches, any dot-directory) are outputs, not material, even though the file tree lists them.
 */
export function isLibraryPath(path: string): boolean {
  const segments = path.split("/");
  return segments[0] !== "renders" && !segments.some((segment) => segment.startsWith("."));
}

export function buildMediaItems(sources: MediaSources): MediaItem[] {
  const byPath = new Map(sources.provenance.map((record) => [record.asset, record]));
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  for (const path of sources.assets) {
    const kind = mediaKindOf(path);
    if (!kind || seen.has(path) || !isLibraryPath(path)) continue;
    seen.add(path);
    const probe = sources.inventory.get(path);
    const provenance = byPath.get(path) ?? null;
    const analysis = sources.analysis.get(path) ?? null;
    items.push({
      path,
      name: fileName(path),
      kind,
      bytes: probe?.bytes ?? null,
      duration: probe?.duration ?? analysis?.duration ?? null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      hasAudio: probe?.hasAudio ?? null,
      origin: originOf(provenance),
      provenance,
      offline: false,
      used: sources.usedPaths.has(path) || (provenance?.usedIn.length ?? 0) > 0,
      analysis,
    });
  }
  for (const record of sources.provenance) {
    if (record.present || seen.has(record.asset)) continue;
    seen.add(record.asset);
    items.push({
      path: record.asset,
      name: fileName(record.asset),
      kind: kindOfResearch(record),
      bytes: record.bytes,
      duration: null,
      width: null,
      height: null,
      hasAudio: null,
      origin: originOf(record),
      provenance: record,
      offline: true,
      used: sources.usedPaths.has(record.asset) || record.usedIn.length > 0,
      analysis: sources.analysis.get(record.asset) ?? null,
    });
  }
  return items;
}

// ── Analysis state ───────────────────────────────────────────────────────────

export function stageOf(item: MediaItem, stage: StageState["stage"]): StageState | null {
  return item.analysis?.stages.find((state) => state.stage === stage) ?? null;
}

export function stageReady(item: MediaItem, stage: StageState["stage"]): boolean {
  return stageOf(item, stage)?.status === "fresh";
}

export function analysisRunning(item: MediaItem): boolean {
  return item.analysis?.stages.some((state) => state.status === "running") ?? false;
}

/**
 * A source the analysis service could still compute something for: a computed stage is missing or stale. Stages
 * this machine cannot produce (`unavailable`) or that failed are not waiting for anything.
 */
export function needsAnalysis(item: MediaItem): boolean {
  if (!item.analysis || item.offline) return false;
  return item.analysis.stages.some(
    (state) => state.stage !== "vision" && (state.status === "missing" || state.status === "stale"),
  );
}

// ── Collections, filters, search ─────────────────────────────────────────────

export type MediaCollection = "all" | MediaKind | MediaOrigin | "unused" | "analysis" | "offline";

export function inCollection(item: MediaItem, collection: MediaCollection): boolean {
  switch (collection) {
    case "all":
      return true;
    case "video":
    case "image":
    case "audio":
    case "font":
      return item.kind === collection;
    case "imported":
    case "research":
    case "download":
      return item.origin === collection;
    case "unused":
      return !item.used;
    case "analysis":
      return needsAnalysis(item) || analysisRunning(item);
    case "offline":
      return item.offline;
  }
}

export type AnalysisFilter = "any" | "transcribed" | "vision" | "scenes" | "needs";

export const ANALYSIS_FILTERS: ReadonlyArray<{ value: AnalysisFilter; label: TranslationKey }> = [
  { value: "any", label: "media.filter.any" },
  { value: "transcribed", label: "media.filter.transcribed" },
  { value: "vision", label: "media.filter.vision" },
  { value: "scenes", label: "media.filter.scenes" },
  { value: "needs", label: "media.filter.needs" },
];

export function passesAnalysis(item: MediaItem, filter: AnalysisFilter): boolean {
  switch (filter) {
    case "any":
      return true;
    case "transcribed":
      return stageReady(item, "transcript");
    case "vision":
      return stageReady(item, "vision");
    case "scenes":
      return stageReady(item, "shots");
    case "needs":
      return needsAnalysis(item);
  }
}

/** What the analysis service knows about a source that a search can look into. */
export interface SearchableAnalysis {
  sentences: readonly TranscriptSentence[];
  vision: readonly VisionNote[];
}

export type MediaMatch =
  | { where: "name" }
  | { where: "transcript"; text: string; time: number }
  | { where: "vision"; text: string; time: number }
  | { where: "source"; text: string };

export function matchItem(
  item: MediaItem,
  rawQuery: string,
  analysis: SearchableAnalysis | undefined,
): MediaMatch | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { where: "name" };
  if (item.name.toLowerCase().includes(query)) return { where: "name" };
  const sentence = analysis?.sentences.find((line) => line.text.toLowerCase().includes(query));
  if (sentence) return { where: "transcript", text: sentence.text, time: sentence.start };
  for (const note of analysis?.vision ?? []) {
    const tag = note.tags.find((value) => value.replaceAll("_", " ").includes(query));
    if (tag) return { where: "vision", text: tag.replaceAll("_", " "), time: note.start };
    if (note.finding.toLowerCase().includes(query)) {
      return { where: "vision", text: note.finding, time: note.start };
    }
  }
  const record = item.provenance;
  if (record) {
    const hit = [record.title, record.author, record.source.name].find(
      (value) => value && value.toLowerCase().includes(query),
    );
    if (hit) return { where: "source", text: hit };
  }
  return null;
}

// ── Sort and sections ────────────────────────────────────────────────────────

export type MediaSort = "kind" | "name" | "duration" | "size";

export const MEDIA_SORTS: ReadonlyArray<{ value: MediaSort; label: TranslationKey }> = [
  { value: "kind", label: "media.sort.kind" },
  { value: "name", label: "media.sort.name" },
  { value: "duration", label: "media.sort.duration" },
  { value: "size", label: "media.sort.size" },
];

/** The one section heading of a flat sort; the kind sort is headed by the kind names. */
const FLAT_SORT_HEADINGS = {
  name: "media.sort.nameGroup",
  duration: "media.sort.durationGroup",
  size: "media.sort.sizeGroup",
} as const satisfies Record<Exclude<MediaSort, "kind">, TranslationKey>;

export interface MediaSection {
  id: string;
  labelKey: TranslationKey;
  items: MediaItem[];
}

const byName = (a: MediaItem, b: MediaItem) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export function sectionItems(items: readonly MediaItem[], sort: MediaSort): MediaSection[] {
  if (sort === "kind") {
    return KIND_ORDER.flatMap((kind) => {
      const group = items.filter((item) => item.kind === kind).sort(byName);
      return group.length ? [{ id: kind, labelKey: KIND_LABELS[kind], items: group }] : [];
    });
  }
  const sorted = [...items].sort((a, b) => {
    if (sort === "duration") return (b.duration ?? -1) - (a.duration ?? -1) || byName(a, b);
    if (sort === "size") return (b.bytes ?? -1) - (a.bytes ?? -1) || byName(a, b);
    return byName(a, b);
  });
  return sorted.length ? [{ id: sort, labelKey: FLAT_SORT_HEADINGS[sort], items: sorted }] : [];
}

// ── Labels ───────────────────────────────────────────────────────────────────

export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long === 3840 && short === 2160) return "UHD";
  if (long === 1920 && short === 1080) return "HD";
  if (long === 1280 && short === 720) return "720p";
  return `${width}×${height}`;
}

/** The card's one-line spec: resolution (or size) and format. */
export function itemSpec(item: MediaItem): string {
  const format = fileExtension(item.path);
  if (item.offline) return [t("media.status.offline"), format].filter(Boolean).join(" · ");
  const parts =
    item.kind === "audio" || item.kind === "font"
      ? [format, item.bytes == null ? null : formatBytes(item.bytes)]
      : [resolutionLabel(item.width, item.height), format];
  return parts.filter(Boolean).join(" · ");
}

/** `mm:ss` (or `h:mm:ss`) for a media length. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
