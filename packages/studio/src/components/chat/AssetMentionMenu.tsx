import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useAgentStore } from "../../agent/agentContext";
import { NEW_CHAT_DRAFT } from "../../agent/agentDraftChat";
import { attachmentKindOf, projectAttachment } from "../../agent/composerAttachments";
import {
  activeMention,
  applyMention,
  matchMentionAssets,
  mentionBasename,
  mentionDirectory,
  mentionToken,
} from "../../agent/composerMentions";
import { isImeKeyEvent } from "../../utils/imeKey";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import { isLibraryPath, mediaKindOf } from "../../media/mediaLibrary";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { POPUP_LAYER } from "../ui/Menu";
import { KIND_ICONS } from "./AttachmentChips";

const NO_ASSETS: readonly string[] = [];

interface MentionMenuProps {
  listId: string;
  optionId: (index: number) => string;
  items: readonly string[];
  hasAssets: boolean;
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (path: string) => void;
}

/** The project files an `@` offers, above the composer box: icon, name, folder; a footer says which keys pick. */
function AssetMentionMenu({
  listId,
  optionId,
  items,
  hasAssets,
  highlight,
  onHighlight,
  onPick,
}: MentionMenuProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = listRef.current?.querySelector("[aria-selected='true']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [highlight, items]);
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-full mb-1 flex flex-col overflow-hidden",
        "rounded-lg border border-border bg-menu-bg/94 shadow-pop backdrop-blur-xl backdrop-saturate-120",
        POPUP_LAYER,
      )}
    >
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("chat.mention.label")}
        data-testid="composer-mention-menu"
        className="max-h-60 overflow-y-auto p-1"
      >
        {items.length === 0 ? (
          <div role="presentation" className="px-2 py-1.5 text-sm text-fg-3">
            {hasAssets ? t("chat.mention.empty") : t("chat.mention.noAssets")}
          </div>
        ) : (
          items.map((path, index) => {
            const Icon = KIND_ICONS[attachmentKindOf(mentionBasename(path))];
            const directory = mentionDirectory(path);
            const selected = index === highlight;
            return (
              <div
                key={path}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                title={path}
                onMouseMove={() => {
                  if (!selected) onHighlight(index);
                }}
                onMouseDown={(event) => {
                  // The textarea keeps the focus (and its caret) through the pick.
                  event.preventDefault();
                  onPick(path);
                }}
                className={cn(
                  "flex h-ctl-sm cursor-default items-center gap-2 rounded-sm px-2 text-sm select-none",
                  selected ? "bg-accent text-accent-ink" : "text-fg",
                )}
              >
                <Icon
                  size={12}
                  aria-hidden
                  className={cn("shrink-0", selected ? "text-accent-ink" : "text-fg-3")}
                />
                <span className="min-w-0 shrink truncate font-medium">{mentionBasename(path)}</span>
                {directory && (
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      selected ? "text-accent-ink/70" : "text-fg-3",
                    )}
                  >
                    {directory}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-border-subtle px-2 py-1 text-xs text-fg-3">
        {t("chat.mention.hint")}
      </div>
    </div>
  );
}

/** What the composer spreads onto its textarea while mentions are wired in. */
export interface MentionFieldProps {
  role: "combobox" | undefined;
  "aria-autocomplete": "list" | undefined;
  "aria-expanded": boolean | undefined;
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
  onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onClick: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onFocus: (event: FocusEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
}

export interface AssetMentions {
  /** The popup, or null while there is no `@` token to complete. */
  menu: ReactNode;
  fieldProps: MentionFieldProps;
  /** Call from the textarea's change handler, after the draft is stored. */
  trackChange: (area: HTMLTextAreaElement) => void;
  /** Handles the keys the popup owns; true when it did (the composer must then do nothing else). */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * `@name` in the prompt: while the caret is inside an `@` token the project's asset files are offered; picking one
 * writes `@<file name> ` into the draft and attaches the file to the message (the same chip a dropped project file
 * gets). Escape closes the popup for that token; it comes back with a new `@` or a caret moved into another one.
 */
export function useAssetMentions({
  areaRef,
  draft,
  disabled,
  setDraft,
}: {
  areaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  disabled: boolean;
  setDraft: (text: string) => void;
}): AssetMentions {
  const listId = useId();
  const fileAssets = useFileManagerContextOptional()?.assets ?? NO_ASSETS;
  // What the Media panel lists: footage, pictures, music and fonts — not renders or Studio's own dot-directories.
  const assets = useMemo(
    () => fileAssets.filter((path) => isLibraryPath(path) && mediaKindOf(path) !== null),
    [fileAssets],
  );
  const draftKey = useAgentStore((state) => state.chatId ?? NEW_CHAT_DRAFT);
  const addAttachments = useAgentStore((state) => state.addAttachments);

  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // The `@` position of the token the user closed with Escape.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState({ key: "", index: 0 });

  const mention = useMemo(() => activeMention(draft, caret), [draft, caret]);
  const items = useMemo(
    () => (mention ? matchMentionAssets(assets, mention.query) : []),
    [assets, mention],
  );
  const open = !disabled && focused && mention !== null && mention.start !== dismissed;
  const key = mention ? `${mention.start}:${mention.query}` : "";
  const highlight = highlighted.key === key ? Math.min(highlighted.index, items.length - 1) : 0;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const track = (area: HTMLTextAreaElement) => {
    const next = area.selectionStart;
    setCaret(next);
    if (activeMention(area.value, next) === null) setDismissed(null);
  };

  // A pick moves the caret after the inserted text once React has written the new value.
  const caretAfterPick = useRef<number | null>(null);
  useLayoutEffect(() => {
    const target = caretAfterPick.current;
    const area = areaRef.current;
    if (target === null || !area) return;
    caretAfterPick.current = null;
    area.setSelectionRange(target, target);
  }, [draft, areaRef]);

  const pick = (path: string) => {
    if (!mention) return;
    const next = applyMention(draft, mention, caret, path);
    caretAfterPick.current = next.caret;
    setCaret(next.caret);
    setDraft(next.text);
    addAttachments(draftKey, [
      { ...projectAttachment({ path }), mentionToken: mentionToken(path) },
    ]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isImeKeyEvent(event.nativeEvent)) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      if (mention) setDismissed(mention.start);
      return true;
    }
    if (items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted({ key, index: (highlight + step + items.length) % items.length });
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      const path = items[highlight];
      if (path === undefined) return false;
      event.preventDefault();
      pick(path);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <AssetMentionMenu
      listId={listId}
      optionId={optionId}
      items={items}
      hasAssets={assets.length > 0}
      highlight={highlight}
      onHighlight={(index) => setHighlighted({ key, index })}
      onPick={pick}
    />
  ) : null;

  return {
    menu,
    trackChange: track,
    handleKeyDown,
    fieldProps: {
      role: open ? "combobox" : undefined,
      "aria-autocomplete": open ? "list" : undefined,
      "aria-expanded": open ? true : undefined,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && items.length > 0 ? optionId(highlight) : undefined,
      onSelect: (event) => track(event.currentTarget),
      onKeyUp: (event) => track(event.currentTarget),
      onClick: (event) => track(event.currentTarget),
      onFocus: (event) => {
        setFocused(true);
        track(event.currentTarget);
      },
      onBlur: () => setFocused(false),
    },
  };
}
