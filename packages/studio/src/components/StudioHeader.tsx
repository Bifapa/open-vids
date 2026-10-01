import { useMemo } from "react";
import { CaretLeft, Export, GearSix } from "@phosphor-icons/react";
import { useStudioShellContext } from "../contexts/StudioContext";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import { readOpenvidsHomeOrigin } from "../utils/openvidsHost";
import { WorkspaceSwitch } from "../story/WorkspaceSwitch";
import { Dock } from "./dock/Dock";
import { openSettings } from "./settings/settingsStore";
import {
  HistoryButtons,
  PanelToggles,
  SaveState,
  TitlebarSeparator,
} from "./shell/TitlebarControls";
import { Button, IconButton, OpenvidsLogo, Tooltip } from "./ui";

export interface StudioHeaderProps {
  onExport?: () => void;
}

/**
 * Inside OpenVids the logo becomes a back button to the Projects home
 * screen. A plain <button> (not an <a href>): the home origin arrives via
 * the query string, and an href would let a crafted link aim the tab at an
 * arbitrary URL before validation runs. Assigning `window.location.href`
 * only after validation keeps one trusted navigation path.
 */
function OpenvidsBackOrLogo({ homeOrigin }: { homeOrigin: string | null }) {
  if (!homeOrigin) return <OpenvidsLogo height={18} className="shrink-0 text-fg" />;
  return (
    <Tooltip label="Back to Projects" side="bottom">
      <button
        type="button"
        aria-label="Back to projects"
        data-testid="openvids-back"
        onClick={() => {
          window.location.href = homeOrigin;
        }}
        className="inline-flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm pr-1.5 pl-2 text-sm text-fg-2 transition-colors duration-hover hover:bg-surface-2 hover:text-fg outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <CaretLeft size={12} weight="bold" aria-hidden />
        Projects
      </button>
    </Tooltip>
  );
}

/**
 * The window's titlebar (prototype `openvids-editor.html`): back to Projects, the project and its
 * save state on the left; the Media | Story | Edit switch centred; history, panel toggles, Window,
 * Export and Settings on the right. In the desktop app the traffic lights sit over its left edge,
 * and the bar itself drags the window.
 */
export function StudioHeader({ onExport }: StudioHeaderProps) {
  const { projectId, renderQueue } = useStudioShellContext();
  const { setRightCollapsed, setRightPanelTab } = usePanelLayoutContext();
  const homeOrigin = useMemo(() => readOpenvidsHomeOrigin(), []);
  const isRendering = renderQueue.isRendering;
  const ffmpegMissing = renderQueue.ffmpegMissing;

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-1 pr-3 pl-5 select-none"
    >
      {/* The desktop's traffic lights (at 20, 20) sit over this inset. */}
      {homeOrigin ? (
        <span aria-hidden="true" data-tauri-drag-region className="mr-3 h-3 w-[52px] shrink-0" />
      ) : null}
      <OpenvidsBackOrLogo homeOrigin={homeOrigin} />
      <span
        data-tauri-drag-region
        title={projectId}
        className="max-w-[260px] truncate text-md font-semibold text-fg"
      >
        {projectId}
      </span>
      <SaveState />
      <WorkspaceSwitch className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
      <div role="toolbar" aria-label="Editor toolbar" className="flex items-center gap-2">
        <HistoryButtons />
        <TitlebarSeparator />
        <PanelToggles />
        <Dock.WindowMenu />
        <TitlebarSeparator />
        <Tooltip
          label={
            ffmpegMissing
              ? "FFmpeg is not installed. Opens the Renders panel with the install command."
              : isRendering
                ? "A render is already in progress"
                : "Render and export this composition"
          }
          side="bottom"
        >
          <Button
            variant="secondary"
            size="sm"
            data-testid="header-export"
            disabled={isRendering}
            icon={<Export size={14} />}
            onClick={() => {
              if (isRendering) return;
              setRightPanelTab("renders");
              setRightCollapsed(false);
              // Without an encoder this render cannot finish, so the click
              // delivers the user to the prompt that fixes it instead of
              // queueing a job that exists only to fail. Disabling the button
              // would leave them staring at a dead control with no route to
              // the explanation.
              if (ffmpegMissing) return;
              onExport?.();
            }}
          >
            {isRendering ? "Rendering…" : "Export"}
          </Button>
        </Tooltip>
        <TitlebarSeparator />
        <Tooltip label="Settings" side="bottom">
          <IconButton
            aria-label="Settings"
            icon={<GearSix size={14} />}
            onClick={() => openSettings()}
          />
        </Tooltip>
      </div>
    </header>
  );
}
