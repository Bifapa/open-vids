import type { ReactNode } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import type {
  StoryAttachment,
  StoryGraph,
  StoryMaterialKind,
  StoryNode,
} from "@hyperframes/agent-protocol";
import { IconButton, cn } from "../components/ui";
import { useStoryStore } from "./storyContext";
import { formatDuration } from "./storyFormat";
import { PLACEMENT_LABELS, STORY_KIND_STYLES } from "./storyKinds";
import { cardImage, Thumb } from "./StoryNodeCard";
import type { StorySelection } from "./storyStore";

/**
 * One row of an inspector list (prototype `.slot`): a small thumbnail or number, the name, a detail and a quiet
 * action that shows on hover. The row itself selects what it stands for.
 */
export function Slot({
  thumb,
  name,
  detail,
  missing,
  onOpen,
  action,
}: {
  thumb: ReactNode;
  name: string;
  detail: ReactNode;
  missing?: boolean;
  onOpen: () => void;
  action?: ReactNode;
}) {
  return (
    <li className="group grid h-[26px] grid-cols-[minmax(0,1fr)_20px] items-center gap-1.5 rounded-sm hover:bg-surface-1">
      <button
        type="button"
        onClick={onOpen}
        className="grid h-full min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-sm pl-0.5 text-left outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span
          className={cn(
            "relative flex h-5 w-9 items-center justify-center overflow-hidden rounded-xs [&>img]:h-full [&>img]:w-full [&>img]:object-cover",
            missing && "border border-dashed border-border-strong text-warning",
          )}
        >
          {thumb}
        </span>
        <span className={cn("truncate text-sm", missing ? "text-fg-2" : "text-fg")} title={name}>
          {name}
        </span>
        <span className="font-mono text-num text-fg-3">{detail}</span>
      </button>
      <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {action}
      </span>
    </li>
  );
}

/** The kind's picture (or glyph) at slot size. */
export function SlotThumb({ node }: { node: StoryNode }) {
  const projectId = useStoryStore((state) => state.projectId ?? "");
  if (node.kind === "missing") return <WarningCircle size={12} aria-hidden />;
  return (
    <span
      className={cn(
        "flex h-full w-full items-center justify-center",
        STORY_KIND_STYLES[node.kind].body,
        STORY_KIND_STYLES[node.kind].kindClass,
        "[&_.hf-sg-placeholder]:text-fg-3",
      )}
    >
      <Thumb src={cardImage(node, projectId)} node={node} />
    </span>
  );
}

function placementOf(attachment: StoryAttachment): string {
  return attachment.offset !== null
    ? `at ${formatDuration(attachment.offset)}`
    : PLACEMENT_LABELS[attachment.placement];
}

/** The materials of the given kinds attached to a chapter, as slots that select them; detaching on hover. */
export function AttachedSlots({
  graph,
  chapterId,
  kinds,
  readOnly,
  onSelect,
  onDetach,
}: {
  graph: StoryGraph;
  chapterId: string;
  kinds: readonly StoryMaterialKind[];
  readOnly: boolean;
  onSelect: (selection: StorySelection) => void;
  onDetach: (attachment: string) => void;
}) {
  const rows = graph.attachments.flatMap((attachment) => {
    if (attachment.chapter !== chapterId) return [];
    const node = graph.nodes.find((candidate) => candidate.id === attachment.node);
    if (!node || node.kind === "chapter" || !kinds.includes(node.kind)) return [];
    return [{ attachment, node }];
  });
  if (rows.length === 0) return <p className="text-sm leading-6 text-fg-3">None</p>;
  return (
    <ul className="grid gap-0.5">
      {rows.map(({ attachment, node }) => (
        <Slot
          key={attachment.id}
          thumb={<SlotThumb node={node} />}
          name={node.title}
          detail={placementOf(attachment)}
          missing={node.kind === "missing"}
          onOpen={() => onSelect({ nodes: [node.id], edges: [] })}
          action={
            <IconButton
              aria-label={`Detach ${node.title}`}
              size="xs"
              disabled={readOnly}
              icon={<X size={10} aria-hidden />}
              onClick={() => onDetach(attachment.id)}
            />
          }
        />
      ))}
    </ul>
  );
}

/** The chapters a material is attached to, numbered in play order; a row opens the attachment. */
export function UsedInSlots({
  graph,
  order,
  nodeId,
  readOnly,
  onSelect,
  onDetach,
}: {
  graph: StoryGraph;
  /** Chapter ids in play order. */
  order: readonly string[];
  nodeId: string;
  readOnly: boolean;
  onSelect: (selection: StorySelection) => void;
  onDetach: (attachment: string) => void;
}) {
  const rows = graph.attachments.flatMap((attachment) => {
    if (attachment.node !== nodeId) return [];
    const chapter = graph.nodes.find((node) => node.id === attachment.chapter);
    return chapter ? [{ attachment, chapter }] : [];
  });
  if (rows.length === 0) {
    return (
      <p className="text-sm leading-[17px] text-fg-3">
        Not attached yet: drag from the card’s top port onto a chapter.
      </p>
    );
  }
  return (
    <ul className="grid gap-0.5">
      {rows.map(({ attachment, chapter }) => {
        const index = order.indexOf(chapter.id);
        return (
          <Slot
            key={attachment.id}
            thumb={
              <span className="flex h-full w-full items-center justify-center bg-surface-2 font-mono text-num font-semibold text-fg">
                {index >= 0 ? String(index + 1).padStart(2, "0") : "–"}
              </span>
            }
            name={chapter.title}
            detail={placementOf(attachment)}
            onOpen={() => onSelect({ nodes: [], edges: [attachment.id] })}
            action={
              <IconButton
                aria-label={`Detach from ${chapter.title}`}
                size="xs"
                disabled={readOnly}
                icon={<X size={10} aria-hidden />}
                onClick={() => onDetach(attachment.id)}
              />
            }
          />
        );
      })}
    </ul>
  );
}
