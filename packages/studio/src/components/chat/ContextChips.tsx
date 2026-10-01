import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  BracketsAngle,
  CursorClick,
  FilmStrip,
  ImageSquare,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import {
  contextChips,
  useComposerContextStore,
  type ContextChip,
  type ContextChipKind,
} from "../../agent/composerContext";
import { useEditorContextSource } from "../../agent/editorContext";
import { useDomEditSelectionContextOptional } from "../../contexts/DomEditContext";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { usePlayerStore } from "../../player";
import { studioStoryStore } from "../../story/storyContext";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";

const KIND_ICONS: Record<ContextChipKind, typeof FilmStrip> = {
  clip: FilmStrip,
  range: BracketsAngle,
  asset: ImageSquare,
  element: CursorClick,
  story: TreeStructure,
};

/**
 * The editor context the next message carries (what `capture()` sends), live: the component re-renders whenever
 * a selection the context reports changes and then reads `capture()` fresh, minus what the user removed.
 */
function useContextChips(): ContextChip[] {
  const projectId = useStudioShellContextOptional()?.projectId;
  const source = useEditorContextSource(projectId);
  // Subscriptions only: they re-render this component when an input of `capture()` changes.
  usePlayerStore(
    useShallow((state) => [
      state.selectedElementId,
      state.selectedElementIds,
      state.elements,
      state.inPoint,
      state.outPoint,
      state.rangeSelection,
    ]),
  );
  useAssetPreviewStore((state) => state.previewAsset);
  useDomEditSelectionContextOptional();
  useStore(studioStoryStore, (state) => state.selection);
  const storyGraph = useStore(studioStoryStore, (state) => state.graph);
  const excluded = useComposerContextStore((state) => state.excluded);

  return contextChips(
    source.capture(),
    (id) => storyGraph?.nodes.find((node) => node.id === id)?.title ?? null,
  ).filter((chip) => !excluded.has(chip.key));
}

/**
 * Context chips above the prompt (prototype `.ov-chat-ctx`): kind icon + label, detail in the tooltip, × removes
 * it from the next message. Hidden when there is nothing to send.
 */
export function ContextChips({ onRemoved }: { onRemoved: () => void }) {
  const chips = useContextChips();
  const exclude = useComposerContextStore((state) => state.exclude);
  if (chips.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Context for the next message"
      data-testid="composer-context"
      className="flex min-w-0 flex-wrap gap-1 px-1.5 pt-1.5"
    >
      {chips.map((chip) => {
        const Icon = KIND_ICONS[chip.kind];
        return (
          <span
            key={chip.key}
            role="listitem"
            title={`${chip.label} · ${chip.detail}`}
            className="inline-flex h-ctl-sm max-w-full min-w-0 items-center gap-[5px] rounded-sm border border-border bg-surface-1 pr-px pl-1.5 text-xs leading-none font-medium text-fg-2 hover:border-border-strong hover:text-fg"
          >
            <Icon size={12} aria-hidden className="shrink-0 text-fg-3" />
            <span className="max-w-[22ch] min-w-0 truncate">{chip.label}</span>
            <button
              type="button"
              aria-label={`Remove ${chip.label} from the next message`}
              onClick={() => {
                exclude(chip.key);
                onRemoved();
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 outline-hidden hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <X size={10} weight="bold" aria-hidden />
            </button>
          </span>
        );
      })}
    </div>
  );
}
