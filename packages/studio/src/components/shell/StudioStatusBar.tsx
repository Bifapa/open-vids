import { Folder } from "@phosphor-icons/react";
import { isChapter } from "@hyperframes/agent-protocol";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import { usePlayerStore } from "../../player";
import { STUDIO_PREVIEW_FPS } from "../../player/lib/time";
import { useStoryStore } from "../../story/storyContext";
import { useCurrentWorkspace, type Workspace } from "../../story/WorkspaceSwitch";
import { Kbd } from "../ui";

interface Hint {
  /** The key cap, when the hint is a shortcut. */
  keys?: string;
  label: string;
}

/** The shortcuts each workspace really answers to (ours, not the prototype's wish list). */
const HINTS: Record<Workspace, readonly Hint[]> = {
  edit: [
    { keys: "Space", label: "Play" },
    { keys: "B", label: "Blade" },
    { keys: "S", label: "Split" },
  ],
  story: [
    { label: "Drag canvas to pan" },
    { label: "Scroll to zoom" },
    { keys: "⌫", label: "Delete" },
  ],
  media: [
    { keys: "Space", label: "Preview" },
    { keys: "⌘F", label: "Search" },
    { label: "Drag to Timeline or Story" },
  ],
};

/** `/Users/me/Movies/x` reads as `~/Movies/x`, the way the prototype prints project paths. */
function homeRelative(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, "~");
}

/** The window's bottom line: where the project lives, then the shown workspace's hints and state. */
export function StudioStatusBar() {
  const { projectDir } = useFileManagerContext();
  const workspace = useCurrentWorkspace();
  const snap = usePlayerStore((state) => state.timelineSnapEnabled);
  const chapters = useStoryStore((state) => state.graph?.nodes.filter(isChapter).length ?? 0);
  return (
    <footer
      data-testid="studio-status-bar"
      className="flex h-[26px] shrink-0 items-center justify-between gap-4 overflow-hidden border-t border-border-subtle bg-bg-1 px-5 text-xs whitespace-nowrap text-fg-3"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {projectDir ? (
          <>
            <Folder size={12} aria-hidden className="shrink-0" />
            <span className="truncate font-mono" title={projectDir}>
              {homeRelative(projectDir)}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {HINTS[workspace].map((hint) => (
          <span key={hint.label} className="inline-flex items-center gap-[5px]">
            {hint.keys ? <Kbd>{hint.keys}</Kbd> : null}
            {hint.label}
          </span>
        ))}
        {workspace === "edit" ? <span>{snap ? "Snap on" : "Snap off"}</span> : null}
        {workspace === "story" ? (
          <span className="font-mono">
            {chapters} {chapters === 1 ? "chapter" : "chapters"}
          </span>
        ) : (
          <span className="font-mono">{STUDIO_PREVIEW_FPS} fps</span>
        )}
      </div>
    </footer>
  );
}
