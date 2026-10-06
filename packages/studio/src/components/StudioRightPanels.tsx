import { useCallback, useEffect } from "react";
import { formatNumber, useTranslation } from "../i18n";
import type { StudioRightPanelsProps } from "./StudioRightPanels.types";

import { PropertyPanel } from "./editor/PropertyPanel";
import { LayersPanel } from "./editor/LayersPanel";
import { CaptionPropertyPanel } from "../captions/components/CaptionPropertyPanel";
import { BlockParamsPanel } from "./editor/BlockParamsPanel";
import { RenderQueuePanel } from "./renders/RenderQueuePanel";
import { SlideshowPanel } from "./panels/SlideshowPanel";
import { AgentChatPanel } from "./chat/AgentChatPanel";
import { askAgentAboutElement } from "./chat/askAboutElement";
import { useEditorRefreshAfterRevert } from "../agent/revertRefresh";
import { useProjectAgentStore } from "../agent/agentContext";
import { useComposerRequestBridge } from "../agent/composerRequest";
import { useEditorContextSource } from "../agent/editorContext";
import { StoryPanel } from "../story/StoryPanel";
import { SettingsDialog } from "./settings/SettingsDialog";
import { DesignHost } from "../design/DesignHost";
import { VoiceHost } from "../voice/VoiceHost";
import { studioStoryStore } from "../story/storyContext";
import { SourcesPanel } from "../research/SourcesPanel";
import { studioSourcesStore } from "../research/researchContext";
import { useSourcesAutoRefresh } from "../research/useSourcesAutoRefresh";
import { MediaPanel } from "../media/MediaPanel";
import { refreshAssetRanges } from "../media/assetRangesStore";
import { hasProjectMedia } from "../media/mediaLibrary";
import { MediaWorkspaceLayout } from "../media/MediaWorkspaceLayout";
import { VariablesPanel } from "./panels/VariablesPanel";
import { Dock } from "./dock/Dock";
import { useDockLayoutStore } from "./dock/dockLayoutStore";
import type { RenderJob } from "./renders/useRenderQueue";
import { useSlideshowPersist } from "../hooks/useSlideshowPersist";
import { useSlideshowTabState } from "../hooks/useSlideshowTabState";
import {
  useBlockParamsDismissal,
  useCaptionDesignFocus,
  useSlideshowDockPanel,
} from "../hooks/useRightPanelIntents";
import { DesignPanelPromoteProvider } from "./DesignPanelPromoteProvider";
import { useStudioPlaybackContext, useStudioShellContext } from "../contexts/StudioContext";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import { useDomEditContext } from "../contexts/DomEditContext";
import { usePlayerStore } from "../player";
import { timelineKeysForSelections } from "../utils/studioHelpers";
import { canHideSelections } from "../utils/timelineInspector";
import { useRemoveBackground } from "../hooks/useRemoveBackground";
import { useApplyColorGradingScope } from "../hooks/useApplyColorGradingScope";

export function StudioRightPanels({
  activeBlockParams,
  onCloseBlockParams,
  onDismissBlockParams,
  recordingState,
  recordingDuration,
  onToggleRecording,
  sdkSession,
  publishSdkSession,
  forceReloadSdkSession,
  syncHistoryPreviewAfterApply,
  reloadPreview,
  recordEdit,
  onToggleElementHidden,
  onAutoGroupCarveSources,
  onAddMediaOverlay,
  onAddAssetToTimeline,
}: StudioRightPanelsProps) {
  const { t } = useTranslation();
  const { previewIframeRef, projectId, activeCompPath, showToast, renderQueue } =
    useStudioShellContext();
  const { captionEditMode, refreshKey } = useStudioPlaybackContext();

  const {
    domEditSelection,
    domEditGroupSelections,
    clearDomSelection,
    handleUngroupSelection,
    handleGroupSelection,
    handleDomStyleCommit,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomPathOffsetCommit,
    handleDomBoxSizeCommit,
    handleDomRotationCommit,
    handleDomTextCommit,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
    selectedGsapAnimations,
    gsapMultipleTimelines,
    gsapUnsupportedTimelinePattern,
    handleGsapUpdateProperty,
    handleGsapUpdateMeta,
    handleGsapDeleteAnimation,
    handleGsapAddAnimation,
    handleGsapAddProperty,
    handleGsapRemoveProperty,
    handleGsapUpdateFromProperty,
    handleGsapAddFromProperty,
    handleGsapRemoveFromProperty,
    commitAnimatedProperty,
    commitAnimatedProperties,
    handleSetArcPath,
    handleUpdateArcSegment,
    handleUnroll,
    handleUpdateKeyframeEase,
    handleUpdateSegmentEase,
    handleSetAllKeyframeEases,
    handleGsapAddKeyframe,
    handleGsapRemoveKeyframe,
    handleGsapConvertToKeyframes,
  } = useDomEditContext();

  const {
    assets,
    fontAssets,
    projectDir,
    fileTree,
    handleImportFiles,
    handleImportFonts,
    refreshFileTree,
    readProjectFile,
    writeProjectFile,
    editingFile,
  } = useFileManagerContext();

  // Discrete ops (toggle, reorder, add/delete, hotspot): persist immediately,
  // no coalescing — each is a distinct user action that deserves its own undo entry.
  const onPersistSlideshow = useSlideshowPersist({
    sdkSession,
    activeCompPath,
    readProjectFile,
    writeProjectFile,
    recordEdit,
    reloadPreview,
    publishSdkSession,
  });

  // Notes path: persists are debounced in SlideshowPanel; coalesceKey ensures
  // rapid writes collapse into a single undo entry via the save-queue infra.
  const onPersistSlideshowNotes = useSlideshowPersist({
    sdkSession,
    activeCompPath,
    readProjectFile,
    writeProjectFile,
    recordEdit,
    reloadPreview,
    publishSdkSession,
    coalesceKey: activeCompPath ? `slideshow-notes:${activeCompPath}` : "slideshow-notes",
  });

  const renderJobs = renderQueue.jobs as RenderJob[];
  const slideshowVisible = useDockLayoutStore((state) => state.visiblePanels.has("slideshow"));
  const { isSlideshowComposition, slideshowScenes } = useSlideshowTabState({
    editingFileContent: editingFile?.content,
    previewIframeRef,
    refreshKey,
    slideshowVisible,
  });
  useSlideshowDockPanel(isSlideshowComposition);
  useBlockParamsDismissal({
    hasBlockParams: activeBlockParams != null,
    onDismiss: onDismissBlockParams,
  });
  useCaptionDesignFocus(captionEditMode);

  const handleApplyColorGradingScope = useApplyColorGradingScope(recordEdit, reloadPreview);

  const handleRemoveBackground = useRemoveBackground(projectId, refreshFileTree, showToast);
  const refreshAfterAgentRevert = useEditorRefreshAfterRevert({
    forceReloadSdkSession,
    syncHistoryPreviewAfterApply,
  });
  // A reverted turn may have restored the story graph and the provenance ledger together with the timeline.
  const onAgentReverted = useCallback(async () => {
    void studioStoryStore.getState().reload();
    void studioSourcesStore.getState().reload();
    refreshAssetRanges();
    await refreshAfterAgentRevert();
  }, [refreshAfterAgentRevert]);
  // One agent store per project, shared by Chat and the Story panel (which starts Review/Build turns).
  const editorContext = useEditorContextSource(projectId);
  const projectHasMedia = useCallback(() => hasProjectMedia(fileTree), [fileTree]);
  const agentStore = useProjectAgentStore(
    projectId,
    editorContext,
    onAgentReverted,
    renderQueue.reloadRenders,
    projectHasMedia,
  );
  // Asking about an element from the inspector or the canvas menu fills this store's composer draft.
  useComposerRequestBridge(agentStore);
  // The story is loaded with the project so the agent's editor context knows its version from the start.
  useEffect(() => {
    void studioStoryStore.getState().open(projectId);
  }, [projectId]);
  // The project's researched assets, for the Sources panel, the Story's license chips and the export check.
  useSourcesAutoRefresh(studioSourcesStore, projectId, agentStore, fileTree);

  /**
   * A dial being dragged writes to the preview and stops there.
   *
   * Every one of these panels previews on each pointermove and commits on
   * release. Persisting the moves too put a fragment of the drag in the undo
   * stack — and since those writes race, history could not coalesce them
   * reliably, so undo took back a sliver of the gesture rather than the gesture.
   * The release's own commit is what reaches the file and the undo stack.
   */
  const setAttributeWhileDragging = useCallback(
    (attr: string, value: string | null) =>
      handleDomAttributeLiveCommit(attr, value, undefined, { previewOnly: true }),
    [handleDomAttributeLiveCommit],
  );
  const handleHideAllSelected = () => {
    // Audio has no visual to hide, and `data-hidden` on an audio element is what
    // MUTES it — preview silences it and the render drops it from the mix. The
    // timeline withholds the eye on an audio track for that reason
    // (`visible={!isAudioTrack}`), and the single-selection panel gates the same
    // write on `audioSelection`; this multi-selection path was the way back to
    // it. Checked here as well as in the panel because the button is not the
    // only caller.
    if (!canHideSelections(domEditGroupSelections)) {
      showToast(t("shell.rightPanel.audioCantHide"), "info");
      return;
    }
    const { elements } = usePlayerStore.getState();
    const keys = timelineKeysForSelections(domEditGroupSelections, elements, activeCompPath);
    if (keys.length > 0) void onToggleElementHidden?.(keys, true);
  };
  const propertyPanel = (
    <DesignPanelPromoteProvider
      selection={domEditGroupSelections.length > 1 ? null : domEditSelection}
      projectId={projectId}
      activeCompPath={activeCompPath}
      showToast={showToast}
      readProjectFile={readProjectFile}
      writeProjectFile={writeProjectFile}
      recordEdit={recordEdit}
      reloadPreview={reloadPreview}
      forceReloadSharedSdkSession={forceReloadSdkSession}
    >
      <PropertyPanel
        projectId={projectId}
        projectDir={projectDir}
        assets={assets}
        element={domEditGroupSelections.length > 1 ? null : domEditSelection}
        multiSelectCount={domEditGroupSelections.length}
        multiSelectedElements={domEditGroupSelections}
        onGroupSelection={handleGroupSelection}
        onHideAllSelected={handleHideAllSelected}
        onClearSelection={clearDomSelection}
        onToggleElementHidden={onToggleElementHidden}
        onAutoGroupCarveSources={onAutoGroupCarveSources}
        onUngroup={handleUngroupSelection}
        onSetStyle={handleDomStyleCommit}
        onSetAttribute={handleDomAttributeCommit}
        onSetAttributes={handleDomAttributesCommit}
        onSetAttributeLive={setAttributeWhileDragging}
        onSetAttributeQuiet={handleDomAttributeQuietCommit}
        onApplyColorGradingScope={handleApplyColorGradingScope}
        onSetHtmlAttribute={handleDomHtmlAttributeCommit}
        onRemoveBackground={handleRemoveBackground}
        onSetManualOffset={handleDomPathOffsetCommit}
        onSetManualSize={handleDomBoxSizeCommit}
        onSetManualRotation={handleDomRotationCommit}
        onSetText={handleDomTextCommit}
        onSetTextFieldStyle={handleDomTextFieldStyleCommit}
        onAddTextField={handleDomAddTextField}
        onRemoveTextField={handleDomRemoveTextField}
        onAskAgent={() => {
          if (domEditSelection) askAgentAboutElement(domEditSelection);
        }}
        onImportAssets={handleImportFiles}
        onAddMediaOverlay={onAddMediaOverlay}
        fontAssets={fontAssets}
        onImportFonts={handleImportFonts}
        previewIframeRef={previewIframeRef}
        gsapAnimations={selectedGsapAnimations}
        gsapMultipleTimelines={gsapMultipleTimelines}
        gsapUnsupportedTimelinePattern={gsapUnsupportedTimelinePattern}
        onUpdateGsapProperty={handleGsapUpdateProperty}
        onUpdateGsapMeta={handleGsapUpdateMeta}
        onDeleteGsapAnimation={handleGsapDeleteAnimation}
        onAddGsapProperty={handleGsapAddProperty}
        onRemoveGsapProperty={handleGsapRemoveProperty}
        onUpdateGsapFromProperty={handleGsapUpdateFromProperty}
        onAddGsapFromProperty={handleGsapAddFromProperty}
        onRemoveGsapFromProperty={handleGsapRemoveFromProperty}
        onAddGsapAnimation={handleGsapAddAnimation}
        onCommitAnimatedProperty={commitAnimatedProperty}
        onCommitAnimatedProperties={commitAnimatedProperties}
        onAddKeyframe={handleGsapAddKeyframe}
        onRemoveKeyframe={handleGsapRemoveKeyframe}
        onConvertToKeyframes={(animId, duration) =>
          handleGsapConvertToKeyframes(animId, undefined, duration)
        }
        onSeekToTime={(t) => usePlayerStore.getState().requestSeek(t)}
        onSetArcPath={handleSetArcPath}
        onUpdateArcSegment={handleUpdateArcSegment}
        onUnroll={handleUnroll}
        onUpdateKeyframeEase={handleUpdateKeyframeEase}
        onUpdateSegmentEase={handleUpdateSegmentEase}
        onSetAllKeyframeEases={handleSetAllKeyframeEases}
        recordingState={recordingState}
        recordingDuration={recordingDuration}
        onToggleRecording={onToggleRecording}
      />
    </DesignPanelPromoteProvider>
  );

  let designBody = propertyPanel;
  if (captionEditMode) {
    designBody = <CaptionPropertyPanel iframeRef={previewIframeRef} />;
  } else if (activeBlockParams) {
    designBody = (
      <BlockParamsPanel
        blockName={activeBlockParams.blockName}
        blockTitle={activeBlockParams.blockTitle}
        params={activeBlockParams.params}
        compositionPath={activeBlockParams.compositionPath}
        onClose={onCloseBlockParams ?? (() => {})}
      />
    );
  }

  return (
    <>
      <Dock.Panel id="design">{designBody}</Dock.Panel>
      <Dock.Panel id="layers">
        <LayersPanel />
      </Dock.Panel>
      <Dock.Panel
        id="renders"
        title={
          renderJobs.length > 0
            ? t("shell.rightPanel.rendersTitle", { count: formatNumber(renderJobs.length) })
            : undefined
        }
      >
        <RenderQueuePanel />
      </Dock.Panel>
      <Dock.Panel id="variables">
        <VariablesPanel
          sdkSession={sdkSession}
          publishSdkSession={publishSdkSession}
          reloadPreview={reloadPreview}
          recordEdit={recordEdit}
        />
      </Dock.Panel>
      <Dock.Panel id="slideshow">
        <SlideshowPanel
          scenes={slideshowScenes}
          onPersist={onPersistSlideshow}
          onPersistNotes={onPersistSlideshowNotes}
        />
      </Dock.Panel>
      <Dock.Panel id="chat">
        <AgentChatPanel store={agentStore} />
      </Dock.Panel>
      <Dock.Panel id="story">
        <StoryPanel projectId={projectId} agentStore={agentStore} />
      </Dock.Panel>
      <Dock.Panel id="media">
        <MediaPanel
          projectId={projectId}
          agentStore={agentStore}
          onAddAssetToTimeline={onAddAssetToTimeline}
          removeBackground={handleRemoveBackground}
        />
      </Dock.Panel>
      <MediaWorkspaceLayout projectId={projectId} />
      <Dock.Panel id="sources">
        <SourcesPanel />
      </Dock.Panel>
      <SettingsDialog agentStore={agentStore} />
      <DesignHost projectId={projectId} agentStore={agentStore} />
      <VoiceHost />
    </>
  );
}
