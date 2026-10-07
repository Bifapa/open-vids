import { useEffect, useMemo } from "react";
import type { AgentStore } from "../agent/agentStore";
import type { DesignTurnSpec } from "../agent/designTurn";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { useFileManagerContextOptional } from "../contexts/FileManagerContext";
import { isLibraryPath, mediaKindOf } from "../media/mediaLibrary";
import { CreateDesignDialog } from "./CreateDesignDialog";
import { useDesignStore, useDesignStoreApi } from "./designContext";
import { useDesignHostCapabilities } from "./designCreate";
import { DesignPreviewDialog } from "./DesignPreviewDialog";
import { takeOpenvidsDesignParam } from "./designParam";
import { useDesignUi } from "./designUiStore";
import { EditDesignDialog } from "./EditDesignDialog";
import { designAgentBlocker, useDesignAgent, useDesignAgentSync } from "./useDesignAgent";

/**
 * The design surface's modals and its upkeep, mounted once with the project's agent store beside the chat (the
 * titlebar's popover only asks for a dialog; starting an agent turn needs the store). It keeps the design state on
 * the open project, reads it again whenever a turn ends, and opens "Create design system" when the desktop shell asks
 * for it once (`openvidsDesign=create`, taken from the address).
 */
export function DesignHost({
  projectId,
  agentStore,
}: {
  projectId: string;
  agentStore: AgentStore | null;
}) {
  const design = useDesignStoreApi();
  const dialog = useDesignUi((state) => state.dialog);
  const systems = useDesignStore((state) => state.library.systems);
  const files = useFileManagerContextOptional();
  const capabilities = useDesignHostCapabilities(projectId, dialog?.kind === "create");
  const agent = useDesignAgent(agentStore);
  const fileTree = files?.fileTree;
  const videos = useMemo(
    () => (fileTree ?? []).filter((path) => mediaKindOf(path) === "video" && isLibraryPath(path)),
    [fileTree],
  );

  useEffect(() => {
    void design.getState().open(projectId);
  }, [design, projectId]);
  useDesignAgentSync(agentStore, design);
  useEffect(() => {
    const request = takeOpenvidsDesignParam();
    if (request) useDesignUi.getState().openCreate(request.source);
  }, []);

  /** Runs the turn and, once the agent took it, shows its progress where it happens: the chat. */
  const start = async (spec: DesignTurnSpec) => {
    const result = await agent.run(spec);
    if (result.ok) {
      useDesignUi.getState().close();
      useDockLayoutStore.getState().activatePanel("chat");
    }
    return result;
  };
  const close = () => useDesignUi.getState().close();
  const blocker = designAgentBlocker(agent);

  switch (dialog?.kind) {
    case "create":
      return (
        <CreateDesignDialog
          initialSource={dialog.source}
          videosLoaded={files === null || files.fileTreeLoaded}
          videos={videos}
          capabilities={capabilities}
          blocker={blocker}
          onStart={start}
          onClose={close}
        />
      );
    case "edit":
      return (
        <EditDesignDialog
          systemId={dialog.systemId}
          name={systems.find((system) => system.id === dialog.systemId)?.name ?? dialog.systemId}
          blocker={blocker}
          onStart={start}
          onClose={close}
        />
      );
    case "preview":
      return <DesignPreviewDialog target={dialog.target} title={dialog.title} onClose={close} />;
    case undefined:
      return null;
  }
}
