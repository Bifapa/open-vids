import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { DownloadSimple, FilmStrip } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { Button, Kbd, cn } from "../components/ui";
import { ContextMenu } from "../components/sidebar/AssetContextMenu";
import { usePlayerStore } from "../player/store/playerStore";
import { studioStoryStore } from "../story/storyContext";
import { TIMELINE_ASSET_MIME } from "../utils/timelineAssetDrop";
import { copyTextToClipboard } from "../utils/clipboard";
import { MediaDropTray, type DropTarget } from "./MediaDropTray";
import { LIST_COLUMNS, MediaCard, MediaRow, type TileHandlers } from "./MediaTiles";
import { MediaToolbar, TILE_SIZE_CLASSES, type MediaViewState } from "./MediaToolbar";
import {
  inCollection,
  matchItem,
  passesAnalysis,
  sectionItems,
  type MediaCollection,
  type MediaItem,
  type MediaMatch,
  type SearchableAnalysis,
} from "./mediaLibrary";
import { showMediaChat } from "./mediaWorkspaceStore";

export interface MediaBrowserProps {
  projectId: string;
  items: readonly MediaItem[];
  collection: MediaCollection;
  collectionLabel: string;
  onResetCollection: () => void;
  searchIndex: ReadonlyMap<string, SearchableAnalysis>;
  loadSearchIndex: () => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onImport: () => void;
  onImportFiles: (files: FileList) => Promise<void>;
  onAddToTimeline?: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onAddToStory: (item: MediaItem, chapterId: string | null) => void;
}

const INITIAL_VIEW: MediaViewState = {
  query: "",
  analysis: "any",
  sort: "kind",
  layout: "grid",
  size: 1,
  showAnalysis: true,
};

function EmptyLibrary({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="media-empty">
      <div className="-mt-[6vh] flex max-w-[380px] flex-col items-center gap-1.5 text-center">
        <div className="mb-1.5 flex size-9 items-center justify-center rounded-lg border border-border bg-surface-1 text-fg-3">
          <FilmStrip size={20} />
        </div>
        <h2 className="m-0 text-lg font-semibold">No media in this project yet</h2>
        <p className="m-0 max-w-[320px] text-sm leading-[17px] text-fg-3">
          Import footage, images and audio, or drop files here. Imported files are copied into the
          project's assets.
        </p>
        <div className="mt-2.5 flex gap-2">
          <Button variant="primary" icon={<DownloadSimple />} onClick={onImport}>
            Import Media…
          </Button>
        </div>
        <p className="mt-3.5 text-xs text-fg-3">
          Need footage you don’t have?{" "}
          <button
            type="button"
            className="text-fg-2 underline underline-offset-2 hover:text-fg"
            onClick={showMediaChat}
          >
            Ask Research in Chat
          </button>{" "}
          — it adds what it finds here, with the source and license.
        </p>
      </div>
    </div>
  );
}

export function MediaBrowser(props: MediaBrowserProps) {
  const { items, collection, searchIndex, loadSearchIndex, selectedPath, onSelect } = props;
  const [view, setView] = useState(INITIAL_VIEW);
  const [dragging, setDragging] = useState<MediaItem | null>(null);
  const [osDrop, setOsDrop] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const graph = useStore(studioStoryStore, (state) => state.graph);
  const playhead = usePlayerStore((state) => state.currentTime);

  // ⌘F searches the library while the Media workspace shows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      const input = searchRef.current?.querySelector("input");
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const searching = view.query.trim().length > 0;
  useEffect(() => {
    if (searching) loadSearchIndex();
  }, [searching, loadSearchIndex]);

  const { visible, matches } = useMemo(() => {
    const found = new Map<string, MediaMatch | null>();
    const kept = items.filter((item) => {
      if (!inCollection(item, collection) || !passesAnalysis(item, view.analysis)) return false;
      const match = matchItem(item, view.query, searchIndex.get(item.path));
      found.set(item.path, match);
      return match !== null;
    });
    return { visible: kept, matches: found };
  }, [items, collection, view.analysis, view.query, searchIndex]);
  const sections = useMemo(() => sectionItems(visible, view.sort), [visible, view.sort]);

  const handlers: TileHandlers = {
    onSelect: (path) => onSelect(path),
    onOpen: (path) => onSelect(path),
    onDragStart: (event: DragEvent, item: MediaItem) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(TIMELINE_ASSET_MIME, JSON.stringify({ path: item.path }));
      event.dataTransfer.setData("text/plain", item.path);
      setDragging(item);
    },
    onDragEnd: () => setDragging(null),
    onContextMenu: (event: MouseEvent, item: MediaItem) => {
      event.preventDefault();
      onSelect(item.path);
      setMenu({ x: event.clientX, y: event.clientY, path: item.path });
    },
  };

  const dropOn = (target: DropTarget) => {
    const item = dragging;
    setDragging(null);
    if (!item) return;
    if (target.kind === "timeline") {
      props.onAddToTimeline?.(item.path);
      return;
    }
    props.onAddToStory(item, target.chapterId);
  };

  const empty = items.length === 0;
  const fileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  let body;
  if (empty) {
    body = <EmptyLibrary onImport={props.onImport} />;
  } else if (visible.length === 0) {
    body = (
      <div className="px-3 py-7 text-center text-sm text-fg-3" data-testid="media-no-match">
        Nothing in {props.collectionLabel} matches
        {view.query ? ` “${view.query}”` : " this filter"}.{" "}
        <button
          type="button"
          className="text-fg-2 underline underline-offset-2 hover:text-fg"
          onClick={() => {
            setView((current) => ({ ...current, query: "", analysis: "any" }));
            props.onResetCollection();
          }}
        >
          Clear filters
        </button>
      </div>
    );
  } else if (view.layout === "grid") {
    body = sections.map((section) => (
      <div key={section.id}>
        <div className="hf-media-group flex items-baseline gap-1.5 px-3.5 pt-3 pb-1.5 text-xs leading-[14px] font-semibold text-fg-2">
          {section.label}
          <span className="font-normal text-fg-3 tabular-nums">{section.items.length}</span>
        </div>
        <div
          className={cn("hf-media-grid", TILE_SIZE_CLASSES[view.size])}
          role="listbox"
          aria-label={section.label}
        >
          {section.items.map((item) => (
            <MediaCard
              key={item.path}
              item={item}
              projectId={props.projectId}
              selected={item.path === selectedPath}
              dragging={dragging?.path === item.path}
              match={matches.get(item.path) ?? null}
              showAnalysis={view.showAnalysis}
              handlers={handlers}
            />
          ))}
        </div>
      </div>
    ));
  } else {
    body = (
      <div className="px-2.5 pb-1" role="listbox" aria-label="Media">
        <div
          aria-hidden="true"
          className={cn(
            LIST_COLUMNS,
            "sticky top-0 z-[4] mb-1 h-list-head border-b border-border-subtle bg-bg-0 text-xs text-fg-3",
          )}
        >
          <span>Name</span>
          <span className="justify-self-end">Duration</span>
          <span>Resolution</span>
          <span>Format</span>
          <span>Origin</span>
          <span>Analysis</span>
          <span>Used</span>
        </div>
        {sections.map((section) => (
          <div key={section.id}>
            <div className="flex items-baseline gap-1.5 px-1 pt-2.5 pb-1 text-xs font-semibold text-fg-2">
              {section.label}
              <span className="font-normal text-fg-3 tabular-nums">{section.items.length}</span>
            </div>
            {section.items.map((item) => (
              <MediaRow
                key={item.path}
                item={item}
                projectId={props.projectId}
                selected={item.path === selectedPath}
                dragging={dragging?.path === item.path}
                match={matches.get(item.path) ?? null}
                showAnalysis={view.showAnalysis}
                handlers={handlers}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!fileDrag(event)) return;
        event.preventDefault();
        setOsDrop(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setOsDrop(false);
      }}
      onDrop={(event) => {
        if (!fileDrag(event)) return;
        event.preventDefault();
        setOsDrop(false);
        if (event.dataTransfer.files.length) void props.onImportFiles(event.dataTransfer.files);
      }}
    >
      <MediaToolbar
        view={view}
        onChange={(patch) => setView((current) => ({ ...current, ...patch }))}
        shown={visible.length}
        total={items.length}
        disabled={empty}
        searchRef={searchRef}
      />
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4 outline-0",
          empty && "flex",
        )}
        data-testid="media-browser"
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelect(null);
        }}
      >
        {body}
      </div>
      {dragging && (
        <MediaDropTray item={dragging} graph={graph} playhead={playhead} onDrop={dropOn} />
      )}
      {osDrop && (
        <div className="pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-lg border-[1.5px] border-dashed border-accent bg-accent-soft text-sm font-medium text-fg">
          Drop to import into this project <Kbd className="ml-2">⌘I</Kbd>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          asset={menu.path}
          onClose={() => setMenu(null)}
          onCopy={(path) => void copyTextToClipboard(path)}
          onDelete={props.onDelete}
          onRename={props.onRename}
          onAddAtPlayhead={props.onAddToTimeline}
        />
      )}
    </div>
  );
}
