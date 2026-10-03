import { clipKey, previewElement, type PreviewSelectionLike } from "../../agent/editorContext";
import { elementKey, useComposerContextStore } from "../../agent/composerContext";
import { useComposerRequestStore } from "../../agent/composerRequest";
import { t } from "../../i18n";
import { usePlayerStore } from "../../player";
import { useDockLayoutStore } from "../dock/dockLayoutStore";

/** The chip keys of the context that stands for the picked element: its own chip, or its clip's. */
function elementChipKeys(selection: PreviewSelectionLike): string[] {
  const keys: string[] = [];
  const element = previewElement(selection);
  if (element) keys.push(elementKey(element));
  if (selection.hfId) {
    for (const clip of usePlayerStore.getState().elements) {
      if (clip.hfId === selection.hfId) keys.push(`clip:${clipKey(clip)}`);
    }
  }
  return keys;
}

/**
 * "Ask Agent about this element": shows the Chat panel, makes sure the element travels with the next message
 * (even if its chip was removed earlier), and leaves a starter in the composer for the user to finish. Nothing
 * is sent, whether or not a turn is running.
 */
export function askAgentAboutElement(selection: PreviewSelectionLike): void {
  useComposerContextStore.getState().include(elementChipKeys(selection));
  const label = selection.label || selection.tagName || t("agent.context.element");
  useComposerRequestStore.getState().ask(t("chat.composer.aboutElement", { label }));
  useDockLayoutStore.getState().activatePanel("chat");
}
