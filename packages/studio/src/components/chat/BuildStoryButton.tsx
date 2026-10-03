import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hammer } from "@phosphor-icons/react";
import { useAgentStoreApi } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { actionBlocker } from "../../story/useStoryAgent";
import { useChapterCount, useStoryActions } from "../../story/useStoryActions";
import { Button, Tooltip } from "../ui";

/**
 * «Build the video»: the Story panel's Build Story, run from the chat. It is the same flow (a pending Story edit is
 * saved first; a story built and then edited on the timeline asks in the same dialog), gated the same way: no turn
 * running and at least one chapter.
 */
export function BuildStoryButton() {
  const { t } = useTranslation();
  const actions = useStoryActions(useAgentStoreApi());
  const blocker = actionBlocker("build", actions.agent, useChapterCount());
  const anchor = useRef<HTMLSpanElement>(null);
  const [overlay, setOverlay] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setOverlay(anchor.current?.closest("[data-chat-overlay]") ?? null);
  }, []);

  return (
    <span ref={anchor} className="inline-flex">
      <Tooltip label={blocker ?? t("story.toolbar.buildTip")}>
        <Button
          size="sm"
          variant="primary"
          data-testid="build-story"
          disabled={blocker !== null}
          icon={<Hammer size={12} aria-hidden />}
          onClick={() => actions.request("build")}
        >
          {t("chat.story.build")}
        </Button>
      </Tooltip>
      {/* The dialog covers the chat panel, not the card it was opened from. */}
      {actions.dialog && (overlay ? createPortal(actions.dialog, overlay) : actions.dialog)}
    </span>
  );
}
