import { buildProjectApiPath } from "../../utils/projectRouting";
import { memo, useState, useCallback, useRef, useMemo, useEffect } from "react";
import { ListBullets, SquaresFour } from "@phosphor-icons/react";
import { useTranslation } from "../../i18n";
import { SearchInput } from "../ui/SearchInput";
import { SegmentedControl, cn } from "../ui";
import { MEDIA_EXT, FONT_EXT } from "@hyperframes/core/media-types";
import { copyTextToClipboard } from "../../utils/clipboard";
import { usePlayerStore } from "../../player/store/playerStore";
import {
  type MediaCategory,
  type CopyFeedback,
  getCategory,
  basename,
  CATEGORY_LABELS,
  FILTER_LABELS,
  FILTER_ORDER,
} from "./assetHelpers";
import { AudioRow } from "./AudioRow";
import { GlobalAssetsView } from "./GlobalAssetsView";
import { AssetCard, FontRow, type AssetLayout } from "./AssetCard";
import {
  DropOverlay,
  ImportButton,
  MediaEmpty,
  NoMatch,
  SectionLabel,
  UsageMenu,
  UsageStrip,
  type UsageFilter,
} from "./AssetsTabParts";

interface AssetsTabProps {
  projectId: string;
  assets: string[];
  onImport?: (files: FileList) => void | Promise<void>;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

type MediaScope = "local" | "global";

/** An OS file drag (not an asset dragged out of this panel). */
function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/** Filter assets by whether the composition references them. Pure — unit-tested. */
export function filterByUsage(
  assets: string[],
  usedPaths: Set<string>,
  usageFilter: UsageFilter,
): string[] {
  if (usageFilter === "used") return assets.filter((a) => usedPaths.has(a));
  if (usageFilter === "unused") return assets.filter((a) => !usedPaths.has(a));
  return assets;
}

/** Count used vs unused over a media set. Pure — unit-tested. */
export function countUsage(
  assets: string[],
  usedPaths: Set<string>,
): { used: number; unused: number } {
  let used = 0;
  for (const a of assets) if (usedPaths.has(a)) used++;
  return { used, unused: assets.length - used };
}

/**
 * Project-relative asset paths referenced by composition elements — the set the
 * "in use" badge, used-first sort, and usage filter all key on. Element src is
 * populated from the core runtime's `resolveNodeAssetUrl` which calls
 * `new URL(raw, document.baseURI).toString()`, turning authored relative paths
 * into fully-absolute URLs with percent-encoded characters, e.g.
 *   "assets/my file (1).mp4"
 *   → "http://localhost:3012/api/projects/demo/preview/assets/my%20file%20(1).mp4"
 *
 * This function normalizes every src shape to the bare project-relative path so
 * it matches the asset-list entries:
 *   - Absolute URL  → strip origin + /api/projects/<id>/preview/ prefix, decode %XX
 *   - Server-relative /api/…preview/… → same strip + decode
 *   - Relative "./"-prefixed or bare → strip leading ./ or /
 *   - ?query / #hash → dropped
 *
 * Pure — unit-tested.
 */
export function deriveUsedPaths(elements: Array<{ src?: string }>): Set<string> {
  const paths = new Set<string>();
  for (const el of elements) {
    if (!el.src) continue;
    let s = el.src;

    // Strip absolute origin if present (http://host/path → /path)
    try {
      const u = new URL(s);
      s = u.pathname + (u.search ? u.search : "") + (u.hash ? u.hash : "");
    } catch {
      // Not a valid absolute URL — leave as-is (relative path)
    }

    s = s
      .replace(/^\/api\/projects\/[^/]+\/preview\//, "") // strip the dev serve prefix
      .replace(/^\.?\//, "") // strip leading ./ or /
      .split(/[?#]/)[0]; // drop query / hash

    // Decode percent-encoded characters (spaces, parens, etc.) so the path
    // matches the plain-text asset-list entries the server returns.
    try {
      s = decodeURIComponent(s);
    } catch {
      // Malformed encoding — use as-is
    }

    if (s) paths.add(s);
  }
  return paths;
}

export const AssetsTab = memo(function AssetsTab({
  projectId,
  assets,
  onImport,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: AssetsTabProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);
  const [importing, setImporting] = useState(false);
  const [activeFilter, setActiveFilter] = useState<MediaCategory | "all">("all");
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<MediaScope>("local");
  const [layout, setLayout] = useState<AssetLayout>("grid");
  const [manifest, setManifest] = useState<
    Map<string, { description?: string; duration?: number; width?: number; height?: number }>
  >(new Map());

  const manifest404Ref = useRef<Set<string>>(new Set());
  const assetsKey = assets.join("|");
  useEffect(() => {
    if (manifest404Ref.current.has(projectId)) return;
    let cancelled = false;
    fetch(buildProjectApiPath(projectId, `/preview/.media/manifest.jsonl`))
      .then((r) => {
        if (!r.ok) {
          manifest404Ref.current.add(projectId);
          return "";
        }
        return r.text();
      })
      .then((text) => {
        if (cancelled || !text) return;
        const m = new Map<
          string,
          { description?: string; duration?: number; width?: number; height?: number }
        >();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.path) m.set(rec.path, rec);
          } catch {
            /* skip */
          }
        }
        setManifest(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, assetsKey]);

  const handleImport = useCallback(
    async (files: FileList) => {
      if (!onImport) return;
      setImporting(true);
      try {
        await onImport(files);
      } finally {
        setImporting(false);
      }
    },
    [onImport],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) void handleImport(e.dataTransfer.files);
    },
    [handleImport],
  );

  const handleCopyPath = useCallback(async (path: string) => {
    const copied = await copyTextToClipboard(path);
    setCopyFeedback({ path, ok: copied });
    setTimeout(() => setCopyFeedback(null), copied ? 1500 : 3000);
  }, []);
  const elements = usePlayerStore((s) => s.elements);
  const usedPaths = useMemo(() => deriveUsedPaths(elements), [elements]);

  // Unfiltered pool — header controls (search, chips) are gated on THIS, not
  // the search-filtered list, so a no-match query can't unmount its own input.
  const allMediaAssets = useMemo(
    () => assets.filter((a) => MEDIA_EXT.test(a) || FONT_EXT.test(a)),
    [assets],
  );

  const mediaAssets = useMemo(() => {
    const all = filterByUsage(allMediaAssets, usedPaths, usageFilter);
    if (!searchQuery) return all;
    const q = searchQuery.toLowerCase();
    return all.filter((a) => {
      if (basename(a).toLowerCase().includes(q)) return true;
      const rec = manifest.get(a);
      return rec?.description?.toLowerCase().includes(q);
    });
  }, [allMediaAssets, searchQuery, manifest, usageFilter, usedPaths]);

  const categorized = useMemo(() => {
    const groups: Record<MediaCategory, string[]> = { audio: [], images: [], video: [], fonts: [] };
    for (const a of mediaAssets) {
      const cat = getCategory(a);
      if (cat) groups[cat].push(a);
    }
    // Sort: used assets first within each category
    for (const cat of FILTER_ORDER) {
      groups[cat].sort((a, b) => {
        const aUsed = usedPaths.has(a) ? 0 : 1;
        const bUsed = usedPaths.has(b) ? 0 : 1;
        return aUsed - bUsed;
      });
    }
    return groups;
  }, [mediaAssets, usedPaths]);
  // Type segments for the kinds the project has at all, so a search can't hide them.
  const presentCategories = useMemo(
    () => FILTER_ORDER.filter((cat) => allMediaAssets.some((a) => getCategory(a) === cat)),
    [allMediaAssets],
  );
  const usageCounts = useMemo(() => {
    const { used, unused } = countUsage(allMediaAssets, usedPaths);
    return { all: allMediaAssets.length, used, unused };
  }, [allMediaAssets, usedPaths]);
  const visibleCategories =
    activeFilter === "all"
      ? FILTER_ORDER.filter((c) => categorized[c].length > 0)
      : [activeFilter].filter((c) => categorized[c].length > 0);

  const local = viewMode === "local";
  const noMedia = allMediaAssets.length === 0;
  const openFilePicker = onImport ? () => fileInputRef.current?.click() : undefined;
  // The usage filter stays offered while it hides something, so it can be cleared.
  const offerUsage = (usageCounts.used > 0 && usageCounts.unused > 0) || usageFilter !== "all";
  const filterOptions = [
    { value: "all" as const, label: t("common.all") },
    ...presentCategories.map((cat) => ({ value: cat, label: t(FILTER_LABELS[cat]) })),
  ];
  const scopeOptions = [
    { value: "local" as const, label: t("sidebar.assets.scopeLocal") },
    {
      value: "global" as const,
      label: t("sidebar.assets.scopeGlobal"),
      title: t("sidebar.assets.scopeGlobalHint"),
    },
  ];
  const layoutOptions = [
    {
      value: "grid" as const,
      label: t("sidebar.assets.layoutGrid"),
      icon: <SquaresFour size={14} aria-hidden="true" />,
    },
    {
      value: "list" as const,
      label: t("sidebar.assets.layoutList"),
      icon: <ListBullets size={14} aria-hidden="true" />,
    },
  ];
  const searchLabel = local ? t("sidebar.assets.searchLocal") : t("sidebar.assets.searchGlobal");

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="mx-2 mt-2 flex shrink-0">
        <SegmentedControl
          label={t("sidebar.assets.scopeLabel")}
          size="sm"
          value={viewMode}
          options={scopeOptions}
          onChange={setViewMode}
          className="flex w-full [&>button]:flex-1"
        />
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2 pb-1.5">
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          disabled={local && noMedia}
          className="h-ctl flex-1"
        />
        {local && (
          <SegmentedControl
            label={t("sidebar.assets.viewLabel")}
            variant="icon"
            value={layout}
            options={layoutOptions}
            onChange={setLayout}
            disabled={noMedia}
          />
        )}
        {local && offerUsage && (
          <UsageMenu value={usageFilter} counts={usageCounts} onChange={setUsageFilter} />
        )}
        {openFilePicker && (
          <>
            <ImportButton importing={importing} onClick={openFilePicker} />
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,image/*,audio/*,font/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleImport(e.target.files);
                  e.target.value = "";
                }
              }}
            />
          </>
        )}
      </div>

      {local && !noMedia && (
        <SegmentedControl
          label={t("sidebar.assets.filterByType")}
          size="sm"
          value={activeFilter}
          options={filterOptions}
          onChange={setActiveFilter}
          className="mx-2 mb-1 flex [&>button]:min-w-0 [&>button]:flex-1 [&>button]:px-1"
        />
      )}
      {local && usageFilter !== "all" && (
        <UsageStrip
          value={usageFilter}
          count={usageCounts[usageFilter]}
          onShowAll={() => setUsageFilter("all")}
        />
      )}

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 [scrollbar-color:var(--color-surface-3)_transparent]">
        {!local ? (
          <GlobalAssetsView searchQuery={searchQuery} />
        ) : noMedia ? (
          <MediaEmpty onImport={openFilePicker} />
        ) : visibleCategories.length === 0 ? (
          <NoMatch searchQuery={searchQuery} onClearSearch={() => setSearchQuery("")} />
        ) : (
          visibleCategories.map((cat) => {
            const items = categorized[cat];
            const rows = layout === "list" || cat === "audio" || cat === "fonts";
            return (
              <section key={cat} aria-label={t(CATEGORY_LABELS[cat])}>
                <SectionLabel count={items.length}>{t(CATEGORY_LABELS[cat])}</SectionLabel>
                <div
                  className={cn(
                    "px-2",
                    rows
                      ? "flex flex-col gap-px"
                      : "grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-1 gap-y-1.5",
                  )}
                >
                  {items.map((a) =>
                    cat === "audio" ? (
                      <AudioRow
                        key={a}
                        projectId={projectId}
                        asset={a}
                        used={usedPaths.has(a)}
                        meta={manifest.get(a)}
                        onCopy={handleCopyPath}
                        copyFeedback={copyFeedback}
                        onDelete={onDelete}
                        onRename={onRename}
                        onAddAssetToTimeline={onAddAssetToTimeline}
                      />
                    ) : cat === "fonts" ? (
                      <FontRow
                        key={a}
                        asset={a}
                        used={usedPaths.has(a)}
                        onCopy={handleCopyPath}
                        copyFeedback={copyFeedback}
                        onDelete={onDelete}
                        onRename={onRename}
                        onAddAssetToTimeline={onAddAssetToTimeline}
                      />
                    ) : (
                      <AssetCard
                        key={a}
                        projectId={projectId}
                        asset={a}
                        used={usedPaths.has(a)}
                        duration={manifest.get(a)?.duration}
                        layout={layout}
                        onCopy={handleCopyPath}
                        copyFeedback={copyFeedback}
                        onDelete={onDelete}
                        onRename={onRename}
                        onAddAssetToTimeline={onAddAssetToTimeline}
                      />
                    ),
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>
      {dragOver && <DropOverlay />}
    </div>
  );
});
