import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { IconButton, Tab, TabPanel, Tabs, TabsList } from "../components/ui";
import { useTranslation } from "../i18n";
import { AgentChatPanel } from "../components/chat/AgentChatPanel";
import type { AgentStore } from "../agent/agentStore";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import { useStudioShellContext } from "../contexts/StudioContext";
import { SourcesPanel } from "../research/SourcesPanel";
import { useResearchServices, useSourcesStore } from "../research/researchContext";
import { studioStoryStore } from "../story/storyContext";
import { MediaBrowser } from "./MediaBrowser";
import { MediaInspector } from "./MediaInspector";
import { COLLECTION_LABELS, MediaLibraryNav, type NavKey } from "./MediaLibraryNav";
import { needsAnalysis, type MediaCollection, type MediaItem } from "./mediaLibrary";
import { attachMediaToStory } from "./mediaStoryDrop";
import { useMediaLibrary } from "./useMediaLibrary";
import { useMediaWorkspaceStore } from "./mediaWorkspaceStore";
import type { RemoveBackground } from "./RemoveBackgroundDialog";
import "./media.css";

function Column({
  head,
  children,
  className,
  testId,
}: {
  head: ReactNode;
  children: ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-0 ${className ?? ""}`}
    >
      <header className="flex h-head flex-none items-center gap-1 border-b border-border-subtle bg-bg-1 px-1.5">
        {head}
      </header>
      {children}
    </section>
  );
}

export interface MediaPanelProps {
  projectId: string;
  agentStore: AgentStore | null;
  onAddAssetToTimeline?: (path: string) => void;
  removeBackground: RemoveBackground;
}

/**
 * The Media workspace: the project's media library (Library collections | browser | asset Inspector and Chat), built
 * from the project's files, the editing inventory's probe facts, the analysis service and the research provenance.
 */
export function MediaPanel({
  projectId,
  agentStore,
  onAddAssetToTimeline,
  removeBackground,
}: MediaPanelProps) {
  const { t } = useTranslation();
  const { assets, handleImportFiles, handleDeleteFile, handleRenameFile } = useFileManagerContext();
  const { showToast } = useStudioShellContext();
  const library = useMediaLibrary(projectId, assets);
  const { items, queue } = library;
  const [collection, setCollection] = useState<MediaCollection>("all");
  const centerTab = useMediaWorkspaceStore((state) => state.centerTab);
  const rightTab = useMediaWorkspaceStore((state) => state.rightTab);
  const selectedPath = useMediaWorkspaceStore((state) => state.selectedPath);
  const { setCenterTab, setRightTab, select } = useMediaWorkspaceStore.getState();
  const { store: sourcesStore } = useResearchServices();
  const sourcesAttention = useSourcesStore(
    (state) => state.view?.records.some((record) => record.issues.length > 0) ?? false,
  );
  const fileInput = useRef<HTMLInputElement>(null);

  // A selection that left the library (deleted, renamed) clears.
  const selected = useMemo(
    () => items.find((item) => item.path === selectedPath) ?? null,
    [items, selectedPath],
  );
  useEffect(() => {
    if (selectedPath && !library.loading && !selected) select(null);
  }, [library.loading, select, selected, selectedPath]);

  const importFiles = useCallback(
    async (files: FileList) => {
      await handleImportFiles(files);
    },
    [handleImportFiles],
  );

  const addToStory = useCallback(
    (item: MediaItem, chapterId: string | null) => {
      const story = studioStoryStore.getState();
      if (!story.graph) return;
      const result = attachMediaToStory(story.graph, item, chapterId);
      if (!result.ok) {
        showToast(result.reason, "error");
        return;
      }
      if (!story.commit(() => result.graph)) {
        showToast(t("media.story.busy"), "error");
        return;
      }
      showToast(t("media.story.added", { name: item.name }), "info");
    },
    [showToast, t],
  );

  const openSources = useCallback(
    (path: string | null) => {
      sourcesStore.getState().reveal(path);
      setCenterTab("sources");
    },
    [setCenterTab, sourcesStore],
  );

  const navKey: NavKey = centerTab === "sources" ? "sources" : collection;
  const onNav = (key: NavKey) => {
    if (key === "sources") {
      openSources(null);
      return;
    }
    setCollection(key);
    setCenterTab("media");
  };

  return (
    <div className="@container/media h-full min-h-0">
      {/* Narrower than a window (Story's left column): library and browser only, the inspector waits for width. */}
      <div
        className="grid h-full min-h-0 grid-cols-[168px_minmax(0,1fr)] gap-1.5 bg-desktop @[900px]/media:grid-cols-[212px_minmax(0,1fr)_320px]"
        data-studio-media=""
        data-testid="media-workspace"
      >
        <Column
          testId="media-library"
          head={
            <>
              <span className="inline-flex h-ctl-sm items-center px-2 text-sm font-medium text-fg">
                {t("media.panel.library")}
              </span>
              <span className="flex-1" />
              <IconButton
                aria-label={t("media.import")}
                size="sm"
                icon={<DownloadSimple className="size-icon-md" />}
                onClick={() => fileInput.current?.click()}
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="video/*,image/*,audio/*,font/*,.woff,.woff2,.ttf,.otf"
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) void importFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </>
          }
        >
          <MediaLibraryNav
            items={items}
            current={navKey}
            onSelect={onNav}
            queue={queue}
            onAnalyzeAll={() =>
              library.analyze(items.filter(needsAnalysis).map((item) => item.path))
            }
          />
        </Column>

        <Tabs
          value={centerTab}
          onValueChange={(value: unknown) =>
            setCenterTab(value === "sources" ? "sources" : "media")
          }
          className="min-h-0 min-w-0"
        >
          <Column
            testId="media-browser-panel"
            className="h-full"
            head={
              <TabsList aria-label={t("media.panel.browserTabs")}>
                <Tab value="media">{t("media.tab.media")}</Tab>
                <Tab value="sources">
                  {t("media.nav.sources")}
                  {sourcesAttention && (
                    <i
                      aria-label={t("media.sources.needsCheck")}
                      className="ml-1 size-1.5 rounded-full bg-warning"
                    />
                  )}
                </Tab>
              </TabsList>
            }
          >
            <TabPanel value="media" className="flex min-h-0 flex-1 flex-col">
              <MediaBrowser
                projectId={projectId}
                items={items}
                collection={collection}
                collectionLabel={t(COLLECTION_LABELS[collection])}
                onResetCollection={() => setCollection("all")}
                searchIndex={library.searchIndex}
                loadSearchIndex={library.loadSearchIndex}
                selectedPath={selectedPath}
                onSelect={select}
                onImport={() => fileInput.current?.click()}
                onImportFiles={importFiles}
                onAddToTimeline={onAddAssetToTimeline}
                onDelete={handleDeleteFile}
                onRename={handleRenameFile}
                onAddToStory={addToStory}
              />
            </TabPanel>
            <TabPanel value="sources" className="flex min-h-0 flex-1 flex-col">
              <SourcesPanel />
            </TabPanel>
          </Column>
        </Tabs>

        <Tabs
          value={rightTab}
          onValueChange={(value: unknown) => setRightTab(value === "chat" ? "chat" : "inspector")}
          className="hidden min-h-0 min-w-0 @[900px]/media:block"
        >
          <Column
            testId="media-right"
            className="h-full"
            head={
              <TabsList aria-label={t("media.panel.rightTabs")}>
                <Tab value="inspector">{t("media.tab.inspector")}</Tab>
                <Tab value="chat">{t("media.tab.chat")}</Tab>
              </TabsList>
            }
          >
            <TabPanel value="inspector" className="flex min-h-0 flex-1 flex-col">
              <MediaInspector
                projectId={projectId}
                item={selected}
                items={items}
                waitingCount={queue.waiting.length + (queue.job || queue.starting ? 1 : 0)}
                onAnalyze={library.analyze}
                onAddToTimeline={onAddAssetToTimeline}
                onAddToStory={addToStory}
                onOpenSources={openSources}
                removeBackground={removeBackground}
              />
            </TabPanel>
            <TabPanel value="chat" className="flex min-h-0 flex-1 flex-col">
              <AgentChatPanel store={agentStore} />
            </TabPanel>
          </Column>
        </Tabs>
      </div>
    </div>
  );
}
