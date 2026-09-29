import { useEffect, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Stop, X } from "@phosphor-icons/react";
import { AGENT_DISPLAY_NAMES } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { activeThread, runningTurn } from "../../agent/agentSelectors";
import { IconButton } from "../ui/IconButton";

const MAX_HEIGHT_PX = 160;

/**
 * The prompt box. Idle, Enter starts a run. While the chat's run is live, Enter steers it and
 * the button is Stop. While another chat holds the project, it explains and stays out of the way.
 * It always talks to the Director, even from an agent's thread, and says so there.
 */
export function Composer() {
  const chatId = useAgentStore((state) => state.chatId);
  const chat = useAgentStore((state) => state.chat);
  const draft = useAgentStore((state) => (state.chatId ? (state.drafts[state.chatId] ?? "") : ""));
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

  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  const running = runningTurn(chat) !== null;
  const blockedBy = activeTurn && activeTurn.chatId !== chatId ? activeTurn : null;
  const blockedTitle = blockedBy ? chats.find((item) => item.id === blockedBy.chatId)?.title : null;
  const busy = pending === "send" || pending === "steer";
  const canSubmit = draft.trim().length > 0 && !busy && !blockedBy && chat !== null;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit) void send();
  };

  // In an agent's thread the addressee is not obvious, so it is named.
  const who = thread === "main" ? "the agent" : "the Director";
  const placeholder = running
    ? `Steer ${who}…`
    : thread === "main"
      ? "Ask the agent…"
      : `Message ${who}…`;

  return (
    <div className="shrink-0 border-t border-border bg-bg-1 p-2">
      {notice && (
        <div
          role="alert"
          className="mb-2 flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-step-11 text-text-1"
        >
          <span>{notice.message}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={dismissNotice}
            className="shrink-0 rounded-sm text-text-3 outline-hidden hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}
      {blockedBy && (
        <p className="mb-2 text-step-11 text-text-3" data-testid="composer-blocked">
          {blockedTitle ? `“${blockedTitle}”` : "Another chat"} is working on this project. You can
          write here once it finishes.{" "}
          <button
            type="button"
            onClick={() => void openChat(blockedBy.chatId)}
            className="text-text-1 underline underline-offset-2 outline-hidden hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open it
          </button>
        </p>
      )}
      {thread !== "main" && !blockedBy && (
        <p className="mb-1 text-step-10 text-text-3" data-testid="composer-thread-hint">
          Viewing {AGENT_DISPLAY_NAMES[thread]}. Messages go to the Director.
        </p>
      )}
      {running && !blockedBy && (
        <p className="mb-1 text-step-10 uppercase tracking-wide text-accent">
          {thread === "main" ? "Agent" : "Director"} is working · your message steers the run
        </p>
      )}
      <div className="flex items-end gap-1.5 rounded-lg border border-border-input bg-input p-1.5 focus-within:border-border-strong">
        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          disabled={blockedBy !== null || chat === null}
          placeholder={blockedBy ? "Waiting for the other chat…" : placeholder}
          aria-label={running ? `Steer ${who}` : `Message ${who}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent px-1 py-0.5 text-step-12 text-text-0 outline-hidden placeholder:text-text-4 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {running ? (
          <>
            {draft.trim() && (
              <IconButton
                aria-label="Send steering message"
                variant="secondary"
                size="sm"
                disabled={!canSubmit}
                onClick={() => void send()}
                icon={<ArrowUp size={14} weight="bold" aria-hidden />}
              />
            )}
            <IconButton
              aria-label="Stop"
              title="Stop the agent"
              variant="danger"
              size="sm"
              disabled={pending === "abort"}
              onClick={() => void abort()}
              icon={<Stop size={14} weight="fill" aria-hidden />}
            />
          </>
        ) : (
          <IconButton
            aria-label="Send"
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            onClick={() => void send()}
            icon={<ArrowUp size={14} weight="bold" aria-hidden />}
          />
        )}
      </div>
    </div>
  );
}
