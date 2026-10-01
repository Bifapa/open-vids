import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check } from "@phosphor-icons/react";
import type { AgentModelInfo, ModelSelection } from "@hyperframes/agent-protocol";
import { sameModel } from "../../agent/agentSelectors";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { buildModelRows, type ModelRow } from "./modelRows";

const ROW_HEIGHT = 28;
const GROUP_HEIGHT = 24;
const VIEWPORT_HEIGHT = 260;

const isSelectable = (row: ModelRow | undefined) => row !== undefined && row.kind !== "group";

function isChosen(row: ModelRow, explicit: ModelSelection | null): boolean {
  if (row.kind === "default") return explicit === null;
  return row.kind === "model" && sameModel(row.model, explicit);
}

function nextSelectable(rows: ModelRow[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    if (isSelectable(rows[index])) return index;
  }
  return from;
}

interface ModelListProps {
  models: readonly AgentModelInfo[];
  /** The chat's own choice; null means it follows the runtime default. */
  explicit: ModelSelection | null;
  /** Name of the model the default resolves to, shown on the "use default" row. */
  defaultName: string | null;
  onSelect: (model: ModelSelection | null) => void;
  /** Offer the "use default" row. Off for lists where only a concrete model makes sense. */
  includeDefault?: boolean;
  /** Multi-select: these rows are checked instead of `explicit`, and picking one toggles it. */
  selected?: readonly ModelSelection[];
  /** Width (and anything else) of the list; a fixed 320 px column by default. */
  className?: string;
}

/** Searchable, provider-grouped model list. ~1200 rows: only the visible ones are in the DOM. */
export function ModelList({
  models,
  explicit,
  defaultName,
  onSelect,
  includeDefault = true,
  selected,
  className,
}: ModelListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => buildModelRows(models, query, includeDefault),
    [models, query, includeDefault],
  );
  const [active, setActive] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    initialRect: { width: 320, height: VIEWPORT_HEIGHT },
  });

  // A new list (first open, or a new query) starts on the chosen model, else its first choice.
  useEffect(() => {
    const chosen = rows.findIndex((row) => isChosen(row, explicit));
    setActive(chosen >= 0 ? chosen : nextSelectable(rows, -1, 1));
  }, [rows, explicit]);

  useEffect(() => {
    if (active >= 0) virtualizer.scrollToIndex(active);
  }, [active, virtualizer]);

  const choose = (row: ModelRow | undefined) => {
    if (row?.kind === "default") onSelect(null);
    else if (row?.kind === "model") {
      onSelect({ provider: row.model.provider, modelId: row.model.modelId });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => nextSelectable(rows, index, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[active]);
    }
  };

  return (
    <div className={cn("flex w-80 flex-col gap-1.5", className)}>
      <input
        type="text"
        role="combobox"
        aria-label={t("chat.models.search")}
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        value={query}
        placeholder={t("chat.models.searchPlaceholder", { count: models.length })}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-ctl-sm w-full rounded-sm border border-border bg-bg-0 px-2 text-sm text-fg outline-hidden placeholder:text-fg-3 hover:border-border-strong focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />
      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label={t("chat.models.list")}
        aria-multiselectable={selected ? true : undefined}
        className="overflow-y-auto"
        style={{ height: VIEWPORT_HEIGHT }}
      >
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-3">{t("chat.models.noMatch", { query })}</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const style = { height: item.size, transform: `translateY(${item.start}px)` };
              if (row.kind === "group") {
                return (
                  <div
                    key={`group-${row.provider}`}
                    role="presentation"
                    style={style}
                    className="absolute left-0 top-0 flex w-full items-end px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-3"
                  >
                    {row.provider}
                  </div>
                );
              }
              const chosen =
                selected && row.kind === "model"
                  ? selected.some((model) => sameModel(model, row.model))
                  : isChosen(row, explicit);
              return (
                <div
                  key={
                    row.kind === "default"
                      ? "default"
                      : `${row.model.provider}/${row.model.modelId}`
                  }
                  id={`${listId}-${item.index}`}
                  role="option"
                  aria-selected={chosen}
                  style={style}
                  onMouseMove={() => setActive(item.index)}
                  onClick={() => choose(row)}
                  className={cn(
                    "absolute left-0 top-0 flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg",
                    item.index === active && "bg-accent text-accent-ink",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {row.kind === "default"
                      ? defaultName
                        ? t("chat.model.defaultNamed", { name: defaultName })
                        : t("common.default")
                      : row.model.name}
                  </span>
                  {row.kind === "model" && row.model.reasoning && (
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        item.index === active ? "text-accent-ink" : "text-fg-3",
                      )}
                    >
                      {t("chat.models.reasoning")}
                    </span>
                  )}
                  {chosen && (
                    <Check
                      size={12}
                      weight="bold"
                      aria-hidden
                      className={cn(
                        "shrink-0",
                        item.index === active ? "text-accent-ink" : "text-fg",
                      )}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
