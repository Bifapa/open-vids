import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PaperPlaneRight, Stop, TreeStructure, X } from "@phosphor-icons/react";
import { useAgentStore } from "../../agent/agentContext";
import { activeThread, runningTurn } from "../../agent/agentSelectors";
import { draftChatSummary } from "../../agent/agentDraftChat";
import { NEW_CHAT_DRAFT } from "../../agent/agentStore";
import { useComposerContextStore } from "../../agent/composerContext";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { cn } from "../ui/cn";
import { Kbd } from "../ui/Kbd";
import { AgentsMenu } from "./AgentsMenu";
import { chatAgentName } from "./AgentMonogram";
import { ComposerPortalContext, chipIconClass, chipLabelClass } from "./composerParts";
import { ContextChips } from "./ContextChips";
import { ExecutionQualityMenu } from "./ExecutionQualityMenu";
import { ModeMenu } from "./ModeMenu";
import { ModelEffortMenu } from "./ModelEffortMenu";

const sendClass = cn(
  "inline-flex h-ctl-sm min-w-ctl-sm shrink-0 items-center justify-center gap-[5px] rounded-sm border text-xs font-semibold whitespace-nowrap",
  "outline-hidden transition-colors duration-hover",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
);

/**
 * The prompt box (prototype `.ov-chat-composer`): context chips, the prompt, and the controls — Model · Effort,
 * Agents · N, Mode, Execution quality, and Send / Steer / Stop. Idle, Enter starts a turn (in story mode while the
 * Story workspace is shown); while the chat's turn runs, Enter steers it and ⌘. stops it. While another chat holds
 * the project it explains and stays out of the way. It always talks to Main, even from an agent's thread.
 */
export function Composer() {
  const chatId = useAgentStore((state) => state.chatId);
  const chat = useAgentStore((state) => state.chat);
  const draftChoices = useAgentStore((state) => state.draftChoices);
  const settings = useAgentStore((state) => state.settings);
  const draft = useAgentStore((state) => state.drafts[state.chatId ?? NEW_CHAT_DRAFT] ?? "");
  const pending = useAgentStore((state) => state.pending);
  const notice = useAgentStore((state) => state.notice);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const setDraft = useAgentStore((state) => state.setDraft);
  const send = useAgentStore((state) => state.send);
  const abort = useAgentStore((state) => state.abort);
  const dismissNotice = useAgentStore((state) => state.dismissNotice);
  const openChat = useAgentStore((state) => state.openChat);
  const chats = useAgentStore((state) => state.chats);
  const thread = useAgentStore((state) => activeThread(state.threads, state.chat));
  // Before the dock mounts every panel counts as visible; only a mounted dock can show the Story workspace.
  const storyShown = useDockLayoutStore(
    (state) => state.controller !== null && state.visiblePanels.has("story"),
  );
  const clearExcluded = useComposerContextStore((state) => state.clear);

  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Grows with the prompt up to eight lines (`field-sizing` is not in every WebView).
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [draft]);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);

  const running = runningTurn(chat) !== null;
  const blockedBy = activeTurn && activeTurn.chatId !== chatId ? activeTurn : null;
  const blockedTitle = blockedBy ? chats.find((item) => item.id === blockedBy.chatId)?.title : null;
  const busy = pending === "send" || pending === "steer";
  const hasText = draft.trim().length > 0;
  // The new-chat draft has no chat yet: its first message creates it.
  const isDraft = chatId === null;
  const canSubmit = hasText && !busy && !blockedBy && (chat !== null || isDraft);
  // The chips edit the open chat, or in the draft the choices its chat will be created with.
  const summary = chat?.chat ?? (isDraft ? draftChatSummary(draftChoices, settings) : null);

  const submit = async () => {
    if (!canSubmit) return;
    // Steering a live turn keeps its mode; a new turn runs in story mode while the Story workspace is shown.
    const sent = await send(running ? undefined : { mode: storyShown ? "story" : "normal" });
    if (sent) clearExcluded();
  };

  // ⌘. stops the run from anywhere in the chat panel (prototype shortcut).
  const stopRef = useRef({ running, abort });
  useEffect(() => {
    stopRef.current = { running, abort };
  });
  useEffect(() => {
    const panel = portal?.parentElement;
    if (!panel) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ".") return;
      if (!stopRef.current.running) return;
      event.preventDefault();
      event.stopPropagation();
      void stopRef.current.abort();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [portal]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const placeholder = blockedBy
    ? "Waiting for the other chat…"
    : running
      ? "Steer the current task…"
      : storyShown
        ? "Describe the story you want, or what to change in it…"
        : "Describe an edit…";

  const mode = running ? (hasText ? "steer" : "stop") : "send";

  return (
    <div
      ref={setPortal}
      className="relative shrink-0 bg-bg-0 @container/composer"
      data-testid="chat-composer"
    >
      <ComposerPortalContext.Provider value={portal}>
        {notice && (
          <div
            role="alert"
            className="mx-2 mb-1.5 flex items-start justify-between gap-2 rounded-md border border-error/30 bg-error-soft px-2 py-1.5 text-sm text-fg"
          >
            <span>{notice.message}</span>
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={dismissNotice}
              className="shrink-0 rounded-xs text-fg-3 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        )}
        {blockedBy && (
          <p className="mx-3 mb-1.5 text-xs text-fg-3" data-testid="composer-blocked">
            {blockedTitle ? `“${blockedTitle}”` : "Another chat"} is working on this project. You
            can write here once it finishes.{" "}
            <button
              type="button"
              onClick={() => void openChat(blockedBy.chatId)}
              className="rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open it
            </button>
          </p>
        )}
        {thread !== "main" && !blockedBy && (
          <p className="mx-3 mb-1 text-xs text-fg-3" data-testid="composer-thread-hint">
            Viewing {chatAgentName(thread)}. Messages go to {chatAgentName("director")}.
          </p>
        )}
        <div
          className={cn(
            "mx-2 mb-2 flex flex-col rounded-md border border-border bg-bg-1 transition-colors duration-hover",
            "hover:border-border-strong @min-[440px]/composer:mx-2.5 @min-[440px]/composer:mb-2.5",
            "has-[textarea:focus-visible]:border-border-strong has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-1 has-[textarea:focus-visible]:outline-accent",
          )}
        >
          <ContextChips onRemoved={() => areaRef.current?.focus({ preventScroll: true })} />
          <label htmlFor="chat-composer-textarea" className="sr-only">
            Message the OpenVids agent
          </label>
          <textarea
            id="chat-composer-textarea"
            ref={areaRef}
            rows={1}
            value={draft}
            disabled={blockedBy !== null || (chat === null && !isDraft)}
            placeholder={placeholder}
            spellCheck
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "block max-h-[156px] min-h-row w-full resize-none overflow-y-auto bg-transparent px-2.5 pt-2 pb-1",
              "text-base leading-[18px] text-fg outline-hidden [field-sizing:content] placeholder:text-fg-3",
              "disabled:cursor-not-allowed disabled:text-fg-2",
            )}
          />
          <div
            className="flex min-w-0 items-center gap-0.5 px-1 pt-0.5 pb-1 @min-[440px]/composer:gap-1 @min-[440px]/composer:px-1.5 @min-[440px]/composer:pt-[3px] @min-[440px]/composer:pb-1.5"
            data-testid="composer-controls"
          >
            {summary && <ModelEffortMenu chat={summary} />}
            {summary && <AgentsMenu chat={summary} />}
            {summary && <ModeMenu chat={summary} />}
            {summary && <ExecutionQualityMenu chat={summary} />}
            {storyShown && !running && (
              <span
                className="inline-flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-fg-2"
                title="Story workspace: the next turn plans the story and leaves the timeline alone"
                data-testid="composer-story-chip"
              >
                <TreeStructure size={12} aria-hidden className={chipIconClass} />
                <span className={chipLabelClass}>Story</span>
              </span>
            )}
            <span aria-hidden className="min-w-0 flex-1" />
            {mode === "stop" ? (
              <button
                key="stop"
                type="button"
                aria-label="Stop task"
                title="Stop task · ⌘."
                disabled={pending === "abort"}
                onClick={() => void abort()}
                className={cn(
                  sendClass,
                  "border-border bg-surface-1 pr-1.5 pl-[5px] text-fg hover:border-border-strong hover:bg-surface-2",
                  "disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
                  "@max-[299px]/composer:px-[5px]",
                )}
              >
                <Stop size={12} weight="fill" aria-hidden />
                <span>Stop</span>
                <Kbd className="h-3.5 px-[3px] text-2xs @max-[439px]/composer:hidden">⌘.</Kbd>
              </button>
            ) : mode === "steer" ? (
              <button
                key="steer"
                type="button"
                aria-label="Steer current task"
                title="Steer current task"
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={cn(
                  sendClass,
                  "border-border bg-surface-1 pr-[7px] pl-1.5 text-fg hover:border-border-strong hover:bg-surface-2",
                  "disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
                  "@max-[299px]/composer:px-[5px]",
                )}
              >
                <PaperPlaneRight size={12} aria-hidden />
                <span>Steer</span>
              </button>
            ) : (
              <button
                key="send"
                type="button"
                aria-label="Send message"
                title="Send · Enter to send"
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={cn(
                  sendClass,
                  "border-transparent bg-accent px-[5px] text-accent-ink hover:bg-accent-hover active:bg-accent-press",
                  "disabled:border-border-subtle disabled:bg-surface-1 disabled:text-fg-disabled",
                )}
              >
                <PaperPlaneRight size={12} weight="fill" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </ComposerPortalContext.Provider>
    </div>
  );
}
