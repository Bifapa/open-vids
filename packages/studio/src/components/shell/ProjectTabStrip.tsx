import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { GitFork, House, Plus, X } from "@phosphor-icons/react";
import { useProjectTabs } from "../../hooks/useProjectTabs";
import { isTranslationKey, useTranslation } from "../../i18n";
import { HOME_TAB_KEY, type ProjectTab } from "../../utils/openvidsTabs";
import { cn, IconButton, Spinner, Tooltip } from "../ui";

const TAB_FOCUS =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";

/** The tab box: a 26 px, 6 px-radius chip. `group` lets the fork and × buttons appear when the box is hovered. */
function tabBoxClass(selected: boolean, inert: boolean): string {
  return cn(
    "group flex h-[26px] items-center rounded-md text-sm transition-colors duration-hover",
    selected ? "bg-surface-2 text-fg" : cn("text-fg-2", !inert && "hover:bg-surface-2"),
  );
}

/** An 18 px icon button at the end of a project tab (fork, ×): hidden until the tab is hovered, focused or selected. */
function tabActionClass(selected: boolean): string {
  return cn(
    "flex size-[18px] shrink-0 items-center justify-center rounded-sm text-fg-3 transition-[opacity,background-color,color] duration-hover",
    "hover:bg-surface-3 hover:text-fg disabled:cursor-not-allowed disabled:text-fg-disabled disabled:hover:bg-transparent",
    "focus-visible:opacity-100",
    TAB_FOCUS,
    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
  );
}

const TAB_BUTTON = cn(
  "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left",
  TAB_FOCUS,
);

/**
 * The tab to move focus to for ←/→ (wrapping), Home and End. Tabs still opening are skipped: they cannot be
 * switched to, so the arrow keys never stop on them.
 */
function tabToFocus(list: HTMLElement, from: HTMLElement, key: string): HTMLElement | null {
  const all = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
  const usable = all.filter((tab) => tab.getAttribute("aria-disabled") !== "true");
  if (usable.length === 0) return null;
  if (key === "Home") return usable[0];
  if (key === "End") return usable[usable.length - 1];
  const step = key === "ArrowRight" ? 1 : -1;
  const start = all.indexOf(from);
  for (let hop = 1; hop <= all.length; hop += 1) {
    const candidate = all[(((start + step * hop) % all.length) + all.length) % all.length];
    if (usable.includes(candidate)) return candidate;
  }
  return null;
}

interface ProjectTabStripViewProps {
  /** The tab shown now: the page's own project key (`"home"` on the Projects page). */
  selectedKey: string;
  /** Project tabs in tab order; the Projects tab is always drawn first and is not part of the list. */
  tabs: readonly ProjectTab[];
  /** The tab with a close request waiting on the shell: every × stays off until it is answered. */
  closingKey: string | null;
  /** The tab with a fork request waiting on the shell: every fork button stays off until it is answered. */
  forkingKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onFork: (key: string) => void;
}

/**
 * The strip of open projects under the titlebar (beta project tabs): Projects, one tab per open project, and
 * a + that goes back to Projects to pick another. It is the same strip the Projects page draws, so the
 * two look alike whichever page is in front. A project still opening shows a spinner and cannot be
 * switched to or closed. `data-keyboard-owner` keeps Studio's global shortcuts (Delete, Space, arrows) out.
 */
export function ProjectTabStripView({
  selectedKey,
  tabs,
  closingKey,
  forkingKey,
  onActivate,
  onClose,
  onFork,
}: ProjectTabStripViewProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState(selectedKey);
  const closing = closingKey !== null;
  const forking = forkingKey !== null;

  // The one tab in the Tab order: the last one focused, else the shown one, else Projects.
  const switchable = (key: string) =>
    key === HOME_TAB_KEY || tabs.some((tab) => tab.key === key && tab.state === "open");
  const tabStop = [focusKey, selectedKey, HOME_TAB_KEY].find(switchable) ?? HOME_TAB_KEY;

  // The shown tab stays in view when the row scrolls sideways.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedKey, tabs.length]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: ProjectTab | null) => {
    const list = listRef.current;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End": {
        if (!list) return;
        event.preventDefault();
        tabToFocus(list, event.currentTarget, event.key)?.focus();
        return;
      }
      case "Delete":
      case "Backspace": {
        // Only a project tab closes, and only while no other close is waiting on the shell.
        if (!tab || tab.state !== "open" || closing) return;
        event.preventDefault();
        onClose(tab.key);
        return;
      }
      default:
    }
  };

  const select = (key: string) => {
    if (key !== selectedKey) onActivate(key);
  };

  return (
    <div
      data-testid="project-tab-strip"
      data-keyboard-owner=""
      data-tauri-drag-region
      className="flex h-head shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-1 px-2 select-none"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("shell.tabs.label")}
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          role="presentation"
          className={cn(tabBoxClass(selectedKey === HOME_TAB_KEY, false), "shrink-0")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={selectedKey === HOME_TAB_KEY}
            tabIndex={tabStop === HOME_TAB_KEY ? 0 : -1}
            data-tab-key={HOME_TAB_KEY}
            onClick={() => select(HOME_TAB_KEY)}
            onFocus={() => setFocusKey(HOME_TAB_KEY)}
            onKeyDown={(event) => onTabKeyDown(event, null)}
            className={cn(TAB_BUTTON, "pr-2.5")}
          >
            <House size={14} aria-hidden />
            <span className="truncate">{t("shell.tabs.projects")}</span>
          </button>
        </div>
        {tabs.map((tab) => {
          const opening = tab.state === "opening";
          const selected = tab.key === selectedKey;
          const openingLabel = t("shell.tabs.opening", { name: tab.name });
          const closeLabel = t("shell.tabs.close", { name: tab.name });
          const forkLabel = t("shell.tabs.fork", { name: tab.name });
          return (
            <div
              key={tab.key}
              role="presentation"
              className={cn(tabBoxClass(selected, opening), "min-w-[120px] max-w-[180px] shrink")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-disabled={opening || undefined}
                aria-busy={opening || undefined}
                aria-label={opening ? openingLabel : undefined}
                title={opening ? openingLabel : tab.name}
                tabIndex={tabStop === tab.key ? 0 : -1}
                data-tab-key={tab.key}
                onClick={() => {
                  if (!opening) select(tab.key);
                }}
                onFocus={() => setFocusKey(tab.key)}
                onKeyDown={(event) => onTabKeyDown(event, tab)}
                className={cn(TAB_BUTTON, opening && "cursor-default")}
              >
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
              </button>
              {opening ? (
                <span className="mr-1 flex size-[18px] shrink-0 items-center justify-center">
                  <Spinner />
                </span>
              ) : (
                <>
                  <Tooltip label={forkLabel} side="bottom">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={forkLabel}
                      disabled={forking}
                      data-testid="project-tab-fork"
                      onClick={() => onFork(tab.key)}
                      className={cn(tabActionClass(selected), "mr-0.5")}
                    >
                      <GitFork size={12} aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip label={closeLabel} side="bottom">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={closeLabel}
                      disabled={closing}
                      data-testid="project-tab-close"
                      onClick={() => onClose(tab.key)}
                      className={cn(tabActionClass(selected), "mr-1")}
                    >
                      <X size={10} weight="bold" aria-hidden />
                    </button>
                  </Tooltip>
                </>
              )}
            </div>
          );
        })}
      </div>
      <Tooltip label={t("shell.tabs.new")} side="bottom">
        <IconButton
          size="sm"
          className="shrink-0"
          aria-label={t("shell.tabs.new")}
          icon={<Plus size={12} weight="bold" aria-hidden />}
          onClick={() => onActivate(HOME_TAB_KEY)}
        />
      </Tooltip>
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
    </div>
  );
}

interface ProjectTabStripProps {
  showToast: (message: string, tone?: "error" | "info") => number | void;
}

/**
 * The strip under the Studio titlebar when project tabs are on (beta, in the desktop, this page has a
 * tab key and the shell says tabs are enabled); nothing at all otherwise, so the layout is the one
 * Studio always had. This page is only visible while it is the active tab, so its own tab is the selected one.
 * A fork the shell starts needs no reply here (the window moves to the Projects page, which shows the
 * copy's progress); one it refuses is a toast.
 */
export function ProjectTabStrip({ showToast }: ProjectTabStripProps) {
  const projectTabs = useProjectTabs();
  const { t } = useTranslation();
  if (!projectTabs) return null;
  const { snapshot, fork } = projectTabs;
  const onFork = async (key: string) => {
    const result = await fork(key);
    if (!result || result.ok) return;
    const name = snapshot.tabs.find((tab) => tab.key === key)?.name ?? key;
    // The Projects page's own wording for the server's code, else the server's message.
    const codeKey = `home.error.${result.code}`;
    const message =
      result.code && isTranslationKey(codeKey)
        ? t(codeKey, result.params)
        : result.message || t("home.error.unknown");
    showToast(t("shell.tabs.forkFailed", { name, message }), "error");
  };
  return (
    <ProjectTabStripView
      selectedKey={projectTabs.ownKey}
      tabs={snapshot.tabs}
      closingKey={projectTabs.closingKey}
      forkingKey={projectTabs.forkingKey}
      onActivate={projectTabs.activate}
      onClose={projectTabs.close}
      onFork={onFork}
    />
  );
}
