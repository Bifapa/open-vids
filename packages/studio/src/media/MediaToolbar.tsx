import type { RefObject } from "react";
import {
  CaretDown,
  DotsThree,
  ImageSquare,
  ListBullets,
  SquaresFour,
  X,
} from "@phosphor-icons/react";
import {
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  SegmentedControl,
  Slider,
  cn,
} from "../components/ui";
import { SearchInput } from "../components/ui/SearchInput";
import { formatNumber, useTranslation } from "../i18n";
import { ANALYSIS_FILTERS, MEDIA_SORTS, type AnalysisFilter, type MediaSort } from "./mediaLibrary";

export type MediaLayout = "grid" | "list";

export interface MediaViewState {
  query: string;
  analysis: AnalysisFilter;
  sort: MediaSort;
  layout: MediaLayout;
  /** Thumbnail size step: 0 small, 1 medium, 2 large. */
  size: number;
  showAnalysis: boolean;
}

/** Small, medium, large tiles; the grid reads the minimum width from `--hf-media-tile`. */
export const TILE_SIZE_CLASSES = [
  "[--hf-media-tile:132px]",
  "[--hf-media-tile:168px]",
  "[--hf-media-tile:216px]",
] as const;

const toolButton =
  "inline-flex h-ctl-sm items-center gap-1 rounded-sm pr-1.5 pl-2 text-sm text-fg-2 outline-hidden transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:text-fg-disabled data-[popup-open]:bg-surface-2";

export function MediaToolbar({
  view,
  onChange,
  shown,
  total,
  disabled,
  searchRef,
}: {
  view: MediaViewState;
  onChange: (patch: Partial<MediaViewState>) => void;
  shown: number;
  total: number;
  disabled: boolean;
  /** The search field's wrapper; ⌘F focuses the input inside it. */
  searchRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const analysisKey = ANALYSIS_FILTERS.find((entry) => entry.value === view.analysis)?.label;
  const sortKey = MEDIA_SORTS.find((entry) => entry.value === view.sort)?.label;
  return (
    <div
      className="flex h-10 flex-none items-center gap-1.5 border-b border-border-subtle px-2"
      data-testid="media-toolbar"
    >
      <div className="relative" ref={searchRef}>
        <SearchInput
          value={view.query}
          onChange={(event) => onChange({ query: event.target.value })}
          placeholder={t("media.toolbar.searchPlaceholder")}
          aria-label={t("media.toolbar.search")}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="h-ctl w-60 transition-[width] focus-within:w-[300px]"
        />
        {view.query && (
          <button
            type="button"
            aria-label={t("media.toolbar.clearSearch")}
            onClick={() => onChange({ query: "" })}
            className="absolute top-1/2 right-1.5 inline-flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full bg-surface-3 text-fg"
          >
            <X size={10} weight="bold" />
          </button>
        )}
      </div>
      <Menu
        aria-label={t("media.toolbar.analysisFilter")}
        trigger={
          <button
            type="button"
            disabled={disabled}
            className={cn(toolButton, view.analysis !== "any" && "bg-surface-2 text-fg")}
          >
            <span className="text-fg-3">{t("media.toolbar.analysis")}</span>
            <span className="text-fg">{analysisKey ? t(analysisKey) : null}</span>
            <CaretDown className="size-icon-xs text-fg-3" />
          </button>
        }
      >
        <MenuRadioGroup
          value={view.analysis}
          onValueChange={(value: unknown) => {
            const next = ANALYSIS_FILTERS.find((entry) => entry.value === value);
            if (next) onChange({ analysis: next.value });
          }}
        >
          {ANALYSIS_FILTERS.map((entry) => (
            <MenuRadioItem key={entry.value} value={entry.value}>
              {t(entry.label)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
      <Menu
        aria-label={t("media.toolbar.sortMedia")}
        trigger={
          <button type="button" disabled={disabled} className={toolButton}>
            <span className="text-fg-3">{t("media.toolbar.sort")}</span>
            <span className="text-fg">{sortKey ? t(sortKey) : null}</span>
            <CaretDown className="size-icon-xs text-fg-3" />
          </button>
        }
      >
        <MenuRadioGroup
          value={view.sort}
          onValueChange={(value: unknown) => {
            const next = MEDIA_SORTS.find((entry) => entry.value === value);
            if (next) onChange({ sort: next.value });
          }}
        >
          {MEDIA_SORTS.map((entry) => (
            <MenuRadioItem key={entry.value} value={entry.value}>
              {t(entry.label)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
      <span className="flex-1" />
      <span className="text-xs whitespace-nowrap text-fg-3 tabular-nums" aria-live="polite">
        {disabled
          ? ""
          : shown === total
            ? t("media.toolbar.items", { count: total })
            : t("media.toolbar.shownOf", {
                shown: formatNumber(shown),
                total: formatNumber(total),
              })}
      </span>
      {view.layout === "grid" && (
        <span
          className="flex items-center gap-1 text-fg-3"
          title={t("media.toolbar.thumbnailSize")}
        >
          <ImageSquare className="size-icon-sm" />
          <Slider
            label={t("media.toolbar.thumbnailSize")}
            value={view.size}
            min={0}
            max={TILE_SIZE_CLASSES.length - 1}
            step={1}
            onPreview={(size) => onChange({ size })}
            onCommit={(size) => onChange({ size })}
            disabled={disabled}
            className="w-16"
          />
        </span>
      )}
      <SegmentedControl
        label={t("media.toolbar.browserView")}
        variant="icon"
        value={view.layout}
        disabled={disabled}
        onChange={(layout) => onChange({ layout })}
        options={[
          {
            value: "grid",
            label: t("media.toolbar.grid"),
            icon: <SquaresFour className="size-icon-md" />,
          },
          {
            value: "list",
            label: t("media.toolbar.list"),
            icon: <ListBullets className="size-icon-md" />,
          },
        ]}
      />
      <Menu
        aria-label={t("media.toolbar.viewOptions")}
        align="end"
        trigger={
          <IconButton
            aria-label={t("media.toolbar.viewOptions")}
            size="sm"
            disabled={disabled}
            icon={<DotsThree className="size-icon-md" weight="bold" />}
          />
        }
      >
        <MenuGroup>
          <MenuGroupLabel>{t("media.toolbar.view")}</MenuGroupLabel>
          <MenuCheckboxItem
            checked={view.showAnalysis}
            onCheckedChange={(checked: boolean) => onChange({ showAnalysis: checked })}
          >
            {t("media.toolbar.showAnalysisIcons")}
          </MenuCheckboxItem>
        </MenuGroup>
      </Menu>
    </div>
  );
}
