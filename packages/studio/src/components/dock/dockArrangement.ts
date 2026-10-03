import type { DockviewApi, SerializedDockview } from "dockview-react";
import { readStudioUiPreferences, writeStudioUiPreferences } from "../../utils/studioUiPreferences";
import { buildEditLayout } from "./dockLayout";
import {
  DEFAULT_STORY_RATIOS,
  arrangeStory,
  readStoryRatios,
  restoreEdit,
  type Arrangement,
} from "./dockWorkspace";

export interface DockArrangement {
  current: () => Arrangement;
  /** True while panels are being moved; layout events in that window describe a half-built dock. */
  moving: () => boolean;
  /** Moves into the Story arrangement, remembering the Edit layout; a no-op in Story already. */
  enterStory: () => void;
  /** Moves back to the Edit layout it remembered; a no-op in Edit. */
  leaveStory: () => void;
  /** Story: the default splits; Edit: the default Edit layout. */
  reset: () => void;
  /** Writes the shown arrangement's layout: Edit as the full dock tree, Story as its two splits. */
  save: () => void;
}

/**
 * The dock's two arrangements and the way between them. Edit is the user's layout and is persisted
 * as `dockLayout`; entering Story stores it (so a relaunch inside Story still has it), moves the
 * panels, and from then on persists only the Story splits. `onChange` runs after every switch.
 */
export function createDockArrangement(
  api: DockviewApi,
  projectId: string | null,
  options: {
    openPanel: (id: "chat" | "media" | "preview" | "story") => void;
    onChange: () => void;
  },
): DockArrangement {
  let arrangement: Arrangement = "edit";
  let moving = false;
  let edit: SerializedDockview | null = null;
  let created: ReadonlySet<string> = new Set();
  const write = (patch: Parameters<typeof writeStudioUiPreferences>[0]) =>
    writeStudioUiPreferences(patch, undefined, projectId);

  const save = () => {
    if (moving) return;
    if (arrangement === "edit") {
      write({ dockLayout: api.toJSON() });
      return;
    }
    const ratios = readStoryRatios(api);
    if (ratios) write({ storyLayout: ratios });
  };

  const enterStory = () => {
    if (arrangement === "story" || moving) return;
    moving = true;
    try {
      // Taken before the Story panels are opened, so a panel the user closed stays closed in Edit.
      const snapshot = api.toJSON();
      for (const id of ["chat", "media", "preview", "story"] as const) {
        if (!api.getPanel(id)) options.openPanel(id);
      }
      const ratios = readStudioUiPreferences(undefined, projectId).storyLayout;
      const groups = arrangeStory(api, ratios ?? DEFAULT_STORY_RATIOS);
      if (!groups) return;
      edit = snapshot;
      created = groups;
      arrangement = "story";
      write({ dockLayout: snapshot, dockWorkspace: "story" });
    } finally {
      moving = false;
    }
    options.onChange();
  };

  const leaveStory = () => {
    if (arrangement === "edit" || moving || !edit) return;
    moving = true;
    try {
      const ratios = readStoryRatios(api);
      restoreEdit(api, edit, created);
      arrangement = "edit";
      edit = null;
      created = new Set();
      write({
        dockLayout: api.toJSON(),
        dockWorkspace: "edit",
        ...(ratios ? { storyLayout: ratios } : {}),
      });
    } finally {
      moving = false;
    }
    options.onChange();
  };

  return {
    current: () => arrangement,
    moving: () => moving,
    enterStory,
    leaveStory,
    reset: () => {
      if (arrangement === "story") {
        leaveStory();
        write({ storyLayout: undefined });
        enterStory();
        return;
      }
      buildEditLayout(api, window.innerWidth);
    },
    save,
  };
}
