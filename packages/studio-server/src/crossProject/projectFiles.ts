import { lstatSync, type Stats } from "node:fs";
import { join, posix } from "node:path";
import {
  PROJECT_MANIFEST_LIMITS,
  isChapter,
  isSoundEffect,
  storyOrder,
  type AssetProvenance,
  type ChapterNode,
  type ProjectFilePart,
  type StoryGraph,
} from "@hyperframes/agent-protocol";
import { assetKindOf } from "../editing/mediaFacts.js";
import { hasMusicToken } from "../helpers/audioNameTokens.js";
import { isInHiddenOrVendorDir, walkDir } from "../helpers/safePath.js";
import { readLedgerReadOnly } from "../research/provenance.js";
import { StoryFailure } from "../story/errors.js";
import { readStoredStory } from "../story/graphIo.js";

/** A media file of another project, as the parts see it. */
export interface ProjectFile {
  /** Project-relative path, `/`-separated. */
  path: string;
  part: ProjectFilePart;
  bytes: number;
  mtimeMs: number;
  /** The file's provenance record in its own project. */
  record: AssetProvenance | null;
}

/** Providers whose whole catalogue is music. */
const MUSIC_SOURCES: Record<string, true> = { ccmixter: true };

/** A path a prompt or a shell must not have to carry: control characters (newlines) cannot be told apart from text. */
const CONTROL_CHARS = /\p{Cc}/u;

function storyOf(root: string): StoryGraph | null {
  try {
    return readStoredStory(root)?.graph ?? null;
  } catch (error) {
    // A damaged graph is "no story" for another project's manifest; the other project's owner sees the error.
    if (error instanceof StoryFailure) return null;
    throw error;
  }
}

interface StoryAudio {
  music: Set<string>;
  effects: Set<string>;
}

/** The story's music and sound-effect files: a music node resolved from a `sfx` need is an effect, not music. */
function storyAudio(graph: StoryGraph | null): StoryAudio {
  const music = new Set<string>();
  const effects = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    if (node.kind !== "music" || node.asset === null) continue;
    (isSoundEffect(node) ? effects : music).add(posix.normalize(node.asset));
  }
  return { music, effects };
}

/** Whether a provenance record says the audio file is music (the need or title names music, or a music-only source). */
function recordIsMusic(record: AssetProvenance): boolean {
  return (
    record.mediaKind === "audio" &&
    (MUSIC_SOURCES[record.source.id] === true ||
      hasMusicToken(record.need ?? "") ||
      hasMusicToken(record.title))
  );
}

/**
 * Every file of another project belongs to exactly one part. Renders are the files under `renders/` (never music,
 * whatever they are called); the rest go by kind, and audio is music when the project's story, the file's provenance
 * record or its path (`music/`, `bgm-…`) says so.
 */
function partOf(
  path: string,
  kind: "video" | "audio" | "image",
  record: AssetProvenance | null,
  audio: StoryAudio,
): ProjectFilePart {
  if (path.startsWith("renders/")) return "renders";
  if (kind === "video") return "video";
  if (kind === "image") return "images";
  if (audio.effects.has(path)) return "audio";
  if (audio.music.has(path)) return "music";
  if (record && recordIsMusic(record)) return "music";
  return hasMusicToken(path) ? "music" : "audio";
}

/**
 * The media files of the project at `root` (an existing real folder), classified into parts. No media probing:
 * only the extension and the file system's own facts. Files in hidden or vendor folders (`.hyperframes/`,
 * `node_modules/`), links, and paths too long or with control characters are not listed.
 */
export function scanProjectFiles(root: string): { files: ProjectFile[]; story: StoryGraph | null } {
  const story = storyOf(root);
  const audio = storyAudio(story);
  const records = new Map(readLedgerReadOnly(root).records.map((record) => [record.asset, record]));
  const files: ProjectFile[] = [];
  for (const path of walkDir(root)) {
    if (
      isInHiddenOrVendorDir(path) ||
      path.length > PROJECT_MANIFEST_LIMITS.pathChars ||
      CONTROL_CHARS.test(path)
    ) {
      continue;
    }
    const kind = assetKindOf(path);
    if (kind !== "video" && kind !== "audio" && kind !== "image") continue;
    let stat: Stats;
    try {
      stat = lstatSync(join(root, path));
    } catch {
      continue;
    }
    // A link could lead anywhere (the walk lists links to files as files): only real files are offered.
    if (!stat.isFile()) continue;
    files.push({
      path,
      part: partOf(path, kind, records.get(path) ?? null, audio),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      record: records.get(path) ?? null,
    });
  }
  return { files, story };
}

/** Chapters of the story in play order. */
export function chaptersOf(story: StoryGraph | null): ChapterNode[] {
  if (!story) return [];
  const byId = new Map(story.nodes.filter(isChapter).map((chapter) => [chapter.id, chapter]));
  return storyOrder(story).chapters.flatMap((id) => byId.get(id) ?? []);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The story as text for an agent: title, brief and the chapters in order, cut at `maxChars`. */
export function storySynopsis(story: StoryGraph, maxChars: number): string {
  const lines = [`Story: ${oneLine(story.title)}`];
  if (oneLine(story.brief) !== "") lines.push(`Brief: ${oneLine(story.brief)}`);
  chaptersOf(story).forEach((chapter, index) => {
    const summary = oneLine(chapter.description) || oneLine(chapter.purpose);
    const length = `${Math.round(chapter.estimatedDuration * 10) / 10}s`;
    lines.push(
      `${index + 1}. ${oneLine(chapter.title)} (~${length})${summary === "" ? "" : `: ${summary}`}`,
    );
  });
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
