import type { StoryPoint } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { readDroppedProjectFile } from "../agent/composerAttachments";
import { mediaKindOf, type MediaItem } from "../media/mediaLibrary";
import { attachMediaToStory } from "../media/mediaStoryDrop";
import type { StoryStore } from "./storyStore";

/** What the Story canvas knows about the pointer at a drop. */
export interface StoryDropPlace {
  /** The drop point in graph coordinates. */
  point: StoryPoint;
  /** The chapter card under the pointer, or null on empty canvas. */
  chapterId: string | null;
}

export interface StoryDropDeps {
  /** Imports an OS file into the project (`useFileManager.uploadProjectFiles`); the paths that landed. */
  upload: (files: File[]) => Promise<string[]>;
  /** The project's files: what a plain-text drag has to name to count as one. */
  projectFiles: ReadonlySet<string>;
}

/** One dropped thing: an OS file still to import, or a file the project already has. */
interface DroppedEntry {
  name: string;
  file?: File;
  path?: string;
}

/** Cascade between several files dropped at once, in graph units. */
const STAGGER = { x: 36, y: 28 };

/** Half a card: the node is centred on the pointer rather than hung from its corner. */
const CARD_HALF = { x: 116, y: 60 };

function droppedEntries(
  dataTransfer: Pick<DataTransfer, "files" | "getData">,
  projectFiles: ReadonlySet<string>,
): DroppedEntry[] {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files.map((file) => ({ name: file.name, file }));
  const project = readDroppedProjectFile(dataTransfer, projectFiles);
  if (!project) return [];
  return [{ name: project.path.slice(project.path.lastIndexOf("/") + 1), path: project.path }];
}

/**
 * Drops on the Story graph. An OS file is imported into the project first; a Media tile or file tree row names a file
 * that is already there. Each video, picture or music file becomes a material node — at the drop point on empty canvas,
 * or below the chapter and attached to it when dropped on a chapter — as one user edit (one undo step each, saved with
 * the user's authorship). Anything else is refused with a message on the canvas.
 */
export async function dropOnStory(
  store: StoryStore,
  dataTransfer: Pick<DataTransfer, "files" | "getData">,
  place: StoryDropPlace,
  deps: StoryDropDeps,
): Promise<void> {
  const setNotice = (message: string | null) => store.getState().setNotice(message);
  const entries = droppedEntries(dataTransfer, deps.projectFiles);

  let index = 0;
  for (const entry of entries) {
    const kind = mediaKindOf(entry.name);
    if (kind === null || kind === "font") {
      setNotice(t("story.drop.unsupported", { name: entry.name }));
      continue;
    }
    let path = entry.path;
    if (!path && entry.file) {
      const importing = t("story.drop.importing", { name: entry.name });
      setNotice(importing);
      path = (await deps.upload([entry.file]).catch(() => []))[0];
      if (!path) {
        setNotice(t("story.drop.importFailed", { name: entry.name }));
        continue;
      }
      if (store.getState().notice === importing) setNotice(null);
    }
    if (!path) continue;
    const item: Pick<MediaItem, "kind" | "path" | "name"> = {
      kind,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
    };
    const at = {
      x: Math.round(place.point.x - CARD_HALF.x + index * STAGGER.x),
      y: Math.round(place.point.y - CARD_HALF.y + index * STAGGER.y),
    };
    index += 1;
    const outcome: { refusal: string | null } = { refusal: null };
    const committed = store.getState().commit((graph) => {
      const result = attachMediaToStory(graph, item, place.chapterId, at);
      if (result.ok) return result.graph;
      outcome.refusal = result.reason;
      return graph;
    });
    if (outcome.refusal) setNotice(outcome.refusal);
    else if (!committed) setNotice(t("media.story.busy"));
  }
}
