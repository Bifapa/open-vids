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
  const analysisLabel = ANALYSIS_FILTERS.find((entry) => entry.value === view.analysis)?.label;
  const sortLabel = MEDIA_SORTS.find((entry) => entry.value === view.sort)?.label;
  return (
    <div
      className="flex h-10 flex-none items-center gap-1.5 border-b border-border-subtle px-2"
      data-testid="media-toolbar"
    >
      <div className="relative" ref={searchRef}>
        <SearchInput
          value={view.query}
          onChange={(event) => onChange({ query: event.target.value })}
          placeholder="Search names, transcripts, tags"
          aria-label="Search media"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="h-ctl w-60 transition-[width] focus-within:w-[300px]"
        />
        {view.query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange({ query: "" })}
            className="absolute top-1/2 right-1.5 inline-flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full bg-surface-3 text-fg"
          >
            <X size={10} weight="bold" />
          </button>
        )}
      </div>
      <Menu
        aria-label="Analysis filter"
        trigger={
          <button
            type="button"
            disabled={disabled}
            className={cn(toolButton, view.analysis !== "any" && "bg-surface-2 text-fg")}
          >
            <span className="text-fg-3">Analysis</span>
            <span className="text-fg">{analysisLabel}</span>
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
              {entry.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
      <Menu
        aria-label="Sort media"
        trigger={
          <button type="button" disabled={disabled} className={toolButton}>
            <span className="text-fg-3">Sort</span>
            <span className="text-fg">{sortLabel}</span>
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
              {entry.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
      <span className="flex-1" />
      <span className="text-xs whitespace-nowrap text-fg-3 tabular-nums" aria-live="polite">
        {disabled ? "" : shown === total ? `${total} items` : `${shown} of ${total}`}
      </span>
      {view.layout === "grid" && (
        <span className="flex items-center gap-1 text-fg-3" title="Thumbnail size">
          <ImageSquare className="size-icon-sm" />
          <Slider
            label="Thumbnail size"
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
        label="Browser view"
        variant="icon"
        value={view.layout}
        disabled={disabled}
        onChange={(layout) => onChange({ layout })}
        options={[
          { value: "grid", label: "Grid", icon: <SquaresFour className="size-icon-md" /> },
          { value: "list", label: "List", icon: <ListBullets className="size-icon-md" /> },
        ]}
      />
      <Menu
        aria-label="View options"
        align="end"
        trigger={
          <IconButton
            aria-label="View options"
            size="sm"
            disabled={disabled}
            icon={<DotsThree className="size-icon-md" weight="bold" />}
          />
        }
      >
        <MenuGroup>
          <MenuGroupLabel>View</MenuGroupLabel>
          <MenuCheckboxItem
            checked={view.showAnalysis}
            onCheckedChange={(checked: boolean) => onChange({ showAnalysis: checked })}
          >
            Show Analysis Icons
          </MenuCheckboxItem>
        </MenuGroup>
      </Menu>
    </div>
  );
}
