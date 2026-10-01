/**
 * Media panel chrome pieces split out of AssetsTab.tsx (600-line gate): import
 * trigger, empty / no-match bodies, OS drop overlay, usage filter menu + strip.
 */
import type { ReactNode } from "react";
import { DownloadSimple, FilmStrip, FunnelSimple } from "@phosphor-icons/react";
import {
  Button,
  IconButton,
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  Spinner,
  Tooltip,
} from "../ui";

export type UsageFilter = "all" | "used" | "unused";

const USAGE_FILTERS: readonly UsageFilter[] = ["all", "used", "unused"];

const USAGE_LABELS: Record<UsageFilter, string> = {
  all: "All Media",
  used: "In Use",
  unused: "Unused",
};

function isUsageFilter(value: unknown): value is UsageFilter {
  return USAGE_FILTERS.some((filter) => filter === value);
}

/** Import trigger. An import is an await, so the button owns the pending state
 *  instead of leaving the author clicking a control that looks idle. */
export function ImportButton({ importing, onClick }: { importing: boolean; onClick: () => void }) {
  return (
    <Tooltip label={importing ? "Importing…" : "Import media…"}>
      <IconButton
        aria-label={importing ? "Importing media" : "Import media"}
        aria-busy={importing}
        disabled={importing}
        onClick={onClick}
        icon={importing ? <Spinner /> : <DownloadSimple size={14} />}
      />
    </Tooltip>
  );
}

/** Section heading over a kind group: the prototype's `.sect-label` with a count. */
export function SectionLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 pt-2.5 pb-1 text-xs leading-[14px] font-semibold text-fg-2">
      {children}
      <span className="font-normal text-fg-3 tabular-nums">{count}</span>
    </div>
  );
}

/** A project with no media yet: what goes here and how to bring it in. */
export function MediaEmpty({ onImport }: { onImport?: () => void }) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-6">
      <div className="-mt-[8vh] flex max-w-60 flex-col items-center gap-1.5 text-center">
        <div className="mb-1.5 flex size-9 items-center justify-center rounded-lg border border-border bg-surface-1 text-fg-3">
          <FilmStrip size={20} aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-fg">No media yet</h2>
        <p className="text-sm text-fg-3 [text-wrap:pretty]">
          Import footage, images, audio and fonts, or drop files here.
        </p>
        {onImport && (
          <Button
            className="mt-2.5"
            variant="primary"
            icon={<DownloadSimple size={14} aria-hidden="true" />}
            onClick={onImport}
          >
            Import Media…
          </Button>
        )}
      </div>
    </div>
  );
}

/** The current search / filters match nothing; a search can be cleared in place. */
export function NoMatch({
  searchQuery,
  onClearSearch,
}: {
  searchQuery: string;
  onClearSearch: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-[18px] text-center text-sm text-fg-3">
      <p>
        {searchQuery ? `No media matches “${searchQuery}”.` : "Nothing here with these filters."}
      </p>
      {searchQuery && (
        <Button size="sm" variant="secondary" onClick={onClearSearch}>
          Clear search
        </Button>
      )}
    </div>
  );
}

/** OS file drag over the panel: the drop target, dashed in the accent. */
export function DropOverlay() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center rounded-md border-[1.5px] border-dashed border-accent bg-bg-0/82"
    >
      <div className="grid justify-items-center gap-1 text-center text-fg">
        <DownloadSimple size={20} className="mb-1 text-accent" />
        <b className="text-md font-semibold">Drop to import</b>
        <span className="text-xs text-fg-3">Video, images, audio and fonts</span>
      </div>
    </div>
  );
}

/** The usage filter (All Media / In Use / Unused) with counts, in the panel's options. */
export function UsageMenu({
  value,
  counts,
  onChange,
}: {
  value: UsageFilter;
  counts: { all: number; used: number; unused: number };
  onChange: (next: UsageFilter) => void;
}) {
  return (
    <Menu
      aria-label="Show media"
      align="end"
      trigger={
        <IconButton
          aria-label="Filter by usage"
          title="Filter by usage"
          aria-pressed={value !== "all"}
          icon={<FunnelSimple size={14} />}
        />
      }
    >
      <MenuRadioGroup
        value={value}
        onValueChange={(next: unknown) => {
          if (isUsageFilter(next)) onChange(next);
        }}
      >
        {USAGE_FILTERS.map((filter) => (
          <MenuRadioItem key={filter} value={filter}>
            <span className="flex min-w-36 items-center justify-between gap-4">
              {USAGE_LABELS[filter]}
              <MenuShortcut>{counts[filter]}</MenuShortcut>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

/** While a usage filter hides media, say so and offer the way back. */
export function UsageStrip({
  value,
  count,
  onShowAll,
}: {
  value: Exclude<UsageFilter, "all">;
  count: number;
  onShowAll: () => void;
}) {
  return (
    <div className="mx-2 mb-1 flex min-h-ctl-sm shrink-0 items-center gap-1.5 rounded-sm bg-surface-1 pr-0.5 pl-2 text-xs text-fg-2">
      <span className="min-w-0 flex-1 truncate">
        Showing <b className="font-semibold text-fg">{USAGE_LABELS[value]}</b> · {count}
      </span>
      <Button size="xs" variant="ghost" onClick={onShowAll}>
        Show All
      </Button>
    </div>
  );
}
