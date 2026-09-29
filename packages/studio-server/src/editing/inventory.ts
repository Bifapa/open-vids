import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type {
  CompositionSummary,
  ProjectAsset,
  ProjectInventory,
  RenderedFile,
} from "@hyperframes/agent-protocol";
import { isCompositionSource } from "../helpers/hfIdPersist.js";
import { isInHiddenOrVendorDir, walkDir } from "../helpers/safePath.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { assetKindOf, type MediaFacts } from "./mediaFacts.js";
import { parseComposition, resolveClipDurations } from "./timeline.js";

/** The entry composition every render without an explicit `composition` uses. */
export const MAIN_COMPOSITION = "index.html";

const RENDER_EXT = /\.(mp4|webm|mov)$/i;
const MEDIA_KINDS = new Set<ProjectAsset["kind"]>(["video", "audio", "image", "font"]);

function summarize(
  project: ResolvedProject,
  path: string,
  facts: MediaFacts,
): CompositionSummary | null {
  let html: string;
  try {
    html = readFileSync(join(project.dir, path), "utf-8");
  } catch {
    return null;
  }
  if (!isCompositionSource(html)) return null;
  const model = parseComposition(html, path);
  if (!model) return null;
  resolveClipDurations(model, (media) => facts.peek(project.dir, media));
  const contentEnd = model.clips.reduce((max, clip) => Math.max(max, clip.end), 0);
  return {
    path,
    width: model.width,
    height: model.height,
    duration: model.duration > 0 ? model.duration : contentEnd,
    clipCount: model.clips.length,
    isMain: path === MAIN_COMPOSITION,
  };
}

function listRenders(project: ResolvedProject, adapter: StudioApiAdapter): RenderedFile[] {
  const dir = adapter.rendersDir(project);
  if (!existsSync(dir)) return [];
  const renders: RenderedFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!RENDER_EXT.test(name)) continue;
    const info = statSync(join(dir, name));
    if (!info.isFile()) continue;
    const inside = relative(project.dir, join(dir, name));
    const path = inside.startsWith("..") ? name : inside.split(sep).join("/");
    renders.push({ path, bytes: info.size, createdAt: info.mtimeMs });
  }
  return renders.sort((a, b) => b.createdAt - a.createdAt);
}

/** What the project holds: compositions with their length, probed media assets, finished renders. */
export async function readInventory(
  project: ResolvedProject,
  adapter: StudioApiAdapter,
  facts: MediaFacts,
): Promise<ProjectInventory> {
  const files = walkDir(project.dir).filter(
    (file) => !isInHiddenOrVendorDir(file) && !file.startsWith("renders/"),
  );
  const mediaPaths = files.filter((file) => MEDIA_KINDS.has(assetKindOf(file))).sort();
  const probed = await facts.readMany(project.dir, mediaPaths);
  const assets = mediaPaths.flatMap((path) => {
    const asset = probed.get(path);
    return asset ? [asset] : [];
  });

  const compositions = files
    .filter((file) => file.endsWith(".html"))
    .sort()
    .flatMap((file) => summarize(project, file, facts) ?? []);
  return { compositions, assets, renders: listRenders(project, adapter) };
}
