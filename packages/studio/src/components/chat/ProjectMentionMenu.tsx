import { useEffect, useRef, type ReactNode } from "react";
import { Check, CaretLeft, FolderSimple } from "@phosphor-icons/react";
import type { ExternalProjectEntry, ProjectPart } from "@hyperframes/agent-protocol";
import { isPartChecked, type PartRow } from "../../agent/projectMentions";
import { PART_ROW_NAMES } from "../../agent/projectMentionLabels";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { POPUP_LAYER } from "../ui/Menu";

/** The popup frame both steps share: above the composer box, a footer that says which keys do what. */
function MenuFrame({
  hint,
  action,
  children,
}: {
  hint: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  // Room for the button; a bare hint line is as slim as the @ popup's.
  const withButton = action !== undefined;
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-full mb-1 flex flex-col overflow-hidden",
        "rounded-lg border border-border bg-menu-bg/94 shadow-pop backdrop-blur-xl backdrop-saturate-120",
        POPUP_LAYER,
      )}
    >
      {children}
      <div
        className={cn(
          "flex items-center gap-2 border-t border-border-subtle px-2 py-1 text-xs text-fg-3",
          withButton && "min-h-ctl",
        )}
      >
        <span className="min-w-0 flex-1">{hint}</span>
        {action}
      </div>
    </div>
  );
}

/** Keeps the row the keys moved to (the one `selector` matches) in view. */
function useScrollToActive(trigger: unknown, selector: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = ref.current?.querySelector(selector);
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [trigger, selector]);
  return ref;
}

const rowClass =
  "flex h-ctl-sm cursor-default items-center gap-2 rounded-sm px-2 text-sm select-none";

interface ListMenuProps {
  listId: string;
  optionId: (index: number) => string;
  projects: readonly ExternalProjectEntry[];
  slugs: ReadonlyMap<string, string>;
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (project: ExternalProjectEntry) => void;
}

/**
 * Step 1 of `#`: the other projects, most recent first, each with the `#token` it writes into the prompt. Only
 * rendered when at least one project matches (the composer decides), so it never says "no matches".
 */
export function ProjectListMenu({
  listId,
  optionId,
  projects,
  slugs,
  highlight,
  onHighlight,
  onPick,
}: ListMenuProps) {
  const { t } = useTranslation();
  const listRef = useScrollToActive(highlight, "[aria-selected='true']");
  return (
    <MenuFrame hint={t("chat.project.hint")}>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("chat.project.label")}
        data-testid="composer-project-menu"
        className="max-h-60 overflow-y-auto p-1"
      >
        {projects.map((project, index) => {
          const selected = index === highlight;
          const slug = slugs.get(project.key);
          return (
            <div
              key={project.key}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              title={project.name}
              onMouseMove={() => {
                if (!selected) onHighlight(index);
              }}
              onMouseDown={(event) => {
                // The textarea keeps the focus (and its caret) through the pick.
                event.preventDefault();
                onPick(project);
              }}
              className={cn(rowClass, selected ? "bg-accent text-accent-ink" : "text-fg")}
            >
              <FolderSimple
                size={12}
                aria-hidden
                className={cn("shrink-0", selected ? "text-accent-ink" : "text-fg-3")}
              />
              <span className="min-w-0 shrink truncate font-medium">{project.name}</span>
              {slug !== undefined && (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs",
                    selected ? "text-accent-ink/70" : "text-fg-3",
                  )}
                >
                  #{slug}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </MenuFrame>
  );
}

/** What step 2 shows while the project's part counts are on their way, or when they could not be read. */
export type PartsView =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; rows: readonly PartRow[] };

interface PartsMenuProps {
  listId: string;
  optionId: (index: number) => string;
  name: string;
  view: PartsView;
  selected: ReadonlySet<ProjectPart>;
  cursor: number;
  canConfirm: boolean;
  onCursor: (index: number) => void;
  onToggle: (part: ProjectPart) => void;
  onConfirm: () => void;
  onBack: () => void;
}

function PartCount({ row }: { row: PartRow }) {
  const { t } = useTranslation();
  if (row.count === null) return null;
  return (
    <span className="ml-auto shrink-0 text-xs tabular-nums">
      {row.part === "story"
        ? t("chat.project.count.chapters", { count: row.count })
        : t("chat.project.count.files", { count: row.count })}
    </span>
  );
}

/**
 * Step 2 of `#`: what of the project to attach, as a checklist with counts. A part with nothing in it is
 * disabled; "All" ticks everything. The footer's Attach button waits for at least one tick.
 */
export function ProjectPartsMenu({
  listId,
  optionId,
  name,
  view,
  selected,
  cursor,
  canConfirm,
  onCursor,
  onToggle,
  onConfirm,
  onBack,
}: PartsMenuProps) {
  const { t } = useTranslation();
  const listRef = useScrollToActive(cursor, "[data-active='true']");
  const heading = t("chat.project.parts.heading", { name });
  const empty = view.status === "ready" && view.rows.every((row) => row.disabled);
  return (
    <MenuFrame
      hint={t("chat.project.parts.hint")}
      action={
        <Button
          variant="primary"
          size="xs"
          tabIndex={-1}
          disabled={!canConfirm}
          // The textarea keeps the focus; the click does the work.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onConfirm}
        >
          {t("chat.project.parts.confirm")}
        </Button>
      }
    >
      <div
        className="flex items-center gap-1 border-b border-border-subtle px-1 py-1"
        data-testid="composer-project-parts"
      >
        <IconButton
          size="xs"
          tabIndex={-1}
          aria-label={t("chat.project.parts.back")}
          icon={<CaretLeft size={12} weight="bold" aria-hidden />}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onBack}
        />
        <span className="min-w-0 truncate text-xs font-medium text-fg-2">{heading}</span>
      </div>
      {view.status === "ready" ? (
        <>
          {empty && (
            <div role="status" className="px-3 pt-1.5 text-xs text-fg-3">
              {t("chat.project.parts.empty")}
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={heading}
            className="max-h-60 overflow-y-auto p-1"
          >
            {view.rows.map((row, index) => {
              const active = index === cursor;
              const checked = isPartChecked(selected, row);
              return (
                <div
                  key={row.part}
                  id={optionId(index)}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={row.disabled || undefined}
                  data-active={active}
                  onMouseMove={() => {
                    if (!active) onCursor(index);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onCursor(index);
                    onToggle(row.part);
                  }}
                  className={cn(
                    rowClass,
                    row.disabled
                      ? cn("text-fg-disabled", active && "bg-surface-2")
                      : active
                        ? "bg-accent text-accent-ink"
                        : "text-fg",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-xs border",
                      checked
                        ? active
                          ? "border-accent-ink bg-accent-ink text-accent"
                          : "border-accent bg-accent text-accent-ink"
                        : active && !row.disabled
                          ? "border-accent-ink/60"
                          : "border-border-strong",
                    )}
                  >
                    {checked && <Check size={10} weight="bold" />}
                  </span>
                  <span className="min-w-0 shrink truncate font-medium">
                    {t(PART_ROW_NAMES[row.part])}
                  </span>
                  <PartCount row={row} />
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div role="status" className="px-3 py-2 text-sm text-fg-3">
          {view.status === "loading"
            ? t("chat.project.parts.loading")
            : t("chat.project.parts.failed")}
        </div>
      )}
    </MenuFrame>
  );
}
