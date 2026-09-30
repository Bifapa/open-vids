import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FilmSlate, LockSimple } from "@phosphor-icons/react";
import type { StoryFrameRef, StoryNode } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import { projectFileUrl, storyFrameUrl } from "./storyClient";
import { HANDLES, type StoryFlowNode } from "./storyFlow";
import { fileName, formatDuration } from "./storyFormat";
import {
  FIELD_LABELS,
  MISSING_KIND_LABELS,
  NARRATIVE_ROLE_LABELS,
  STORY_KIND_STYLES,
} from "./storyKinds";
import { SyncBadges } from "./SyncBadges";

/** The frame a card shows: the node's own pick, else the middle of its first range / its in-point. */
function cardFrame(node: StoryNode): StoryFrameRef | null {
  if (node.kind === "chapter") {
    if (node.previewFrame) return node.previewFrame;
    const first = node.sourceRanges[0];
    return first ? { source: first.source, time: (first.from + first.to) / 2 } : null;
  }
  if (node.kind === "video")
    return node.previewFrame ?? { source: node.asset, time: node.sourceIn };
  return null;
}

function cardImage(node: StoryNode, projectId: string): string | null {
  if (node.kind === "picture") return projectFileUrl(projectId, node.asset);
  const frame = cardFrame(node);
  return frame ? storyFrameUrl(projectId, frame.source, frame.time) : null;
}

function Thumb({ src, node }: { src: string | null; node: StoryNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const style = STORY_KIND_STYLES[node.kind];
  const KindIcon = style.icon;
  if (!src || failedSrc === src) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center", style.tint)}>
        <KindIcon size={22} className={cn(style.text, "opacity-70")} aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailedSrc(src)}
      className="h-full w-full object-cover"
    />
  );
}

/** Lock and "edited by you" marks, shared by both card kinds. */
function Marks({ node }: { node: StoryNode }) {
  const edited = node.userEdited.map((field) => FIELD_LABELS[field] ?? field);
  const byYou = node.createdBy === "user" || edited.length > 0;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {byYou && (
        <span
          className="size-1.5 rounded-full bg-selection"
          title={edited.length > 0 ? `Edited by you: ${edited.join(", ")}` : "Added by you"}
          aria-label={edited.length > 0 ? "Edited by you" : "Added by you"}
          role="img"
        />
      )}
      {node.locked && (
        <LockSimple
          size={11}
          weight="fill"
          className="text-text-2"
          aria-label="Locked: the agent will not change it"
        />
      )}
    </span>
  );
}

function ChapterCardImpl({ data, selected }: NodeProps<StoryFlowNode>) {
  const { node, facts, projectId, number } = data;
  if (node.kind !== "chapter") return null;
  const style = STORY_KIND_STYLES.chapter;
  const onTimeline = facts?.timeline ?? null;
  const material = facts?.materialDuration;
  return (
    <div
      className={cn(
        "w-[232px] overflow-hidden rounded-lg border border-t-2 border-border-input bg-surface text-left shadow-menu",
        style.border,
        selected && "ring-2 ring-selection",
        node.locked && "border-dashed",
      )}
      data-story-node={node.id}
    >
      <Handle
        id={HANDLES.sequenceIn}
        type="target"
        position={Position.Left}
        className="hf-story-handle-sequence"
        aria-label="Plays after"
      />
      <Handle
        id={HANDLES.sequenceOut}
        type="source"
        position={Position.Right}
        className="hf-story-handle-sequence"
        aria-label="Plays before"
      />
      <Handle
        id={HANDLES.material}
        type="target"
        position={Position.Bottom}
        className="hf-story-handle-material"
        aria-label="Attach material"
      />
      <div className="relative aspect-video w-full bg-bg-2">
        <Thumb src={cardImage(node, projectId)} node={node} />
        <span className="absolute left-1.5 top-1.5 rounded-sm bg-bg-0/80 px-1.5 py-0.5 text-step-10 font-semibold tabular-nums text-text-0">
          {number !== null ? `#${number}` : "–"}
        </span>
        <span
          className="absolute bottom-1.5 right-1.5 rounded-sm bg-bg-0/80 px-1.5 py-0.5 text-step-10 font-medium tabular-nums text-text-0"
          title={
            material !== undefined && material !== null
              ? `Planned ${formatDuration(node.estimatedDuration)} · A-roll ${formatDuration(material)} after cleanup`
              : `Planned ${formatDuration(node.estimatedDuration)}`
          }
        >
          {formatDuration(node.estimatedDuration)}
        </span>
        {onTimeline && (
          <span
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-sm bg-accent/90 px-1.5 py-0.5 text-step-10 font-semibold text-bg-0"
            title={`On the timeline ${formatDuration(onTimeline.start)}–${formatDuration(onTimeline.end)} (${onTimeline.clips} clips)`}
          >
            <FilmSlate size={10} weight="bold" aria-hidden />
            On timeline
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 pb-2 pt-1.5">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-step-12 font-semibold text-text-0">
            {node.title}
          </span>
          <Marks node={node} />
        </div>
        <div className="flex items-center gap-1.5 text-step-10 text-text-3">
          <span className={cn("font-medium", style.text)}>
            {NARRATIVE_ROLE_LABELS[node.narrativeRole]}
          </span>
          {node.status !== "approved" && (
            <span className={node.status === "needs_material" ? "text-danger" : undefined}>
              · {node.status === "needs_material" ? "needs material" : "proposed"}
            </span>
          )}
          {material !== undefined && material !== null && (
            <span className="ml-auto tabular-nums">A-roll {formatDuration(material)}</span>
          )}
        </div>
        <p className="truncate text-step-11 text-text-2">
          {node.description || node.purpose || "No description yet"}
        </p>
        <SyncBadges badges={data.sync} className="pt-0.5" />
      </div>
    </div>
  );
}

function materialLine(node: StoryNode): string {
  switch (node.kind) {
    case "video":
      return node.sourceOut !== null
        ? `${fileName(node.asset)} · ${formatDuration(node.sourceIn)}–${formatDuration(node.sourceOut)}`
        : fileName(node.asset);
    case "picture":
      return fileName(node.asset);
    case "music":
      return node.asset ? fileName(node.asset) : "No track chosen yet";
    case "motion":
      return node.duration !== null
        ? `${node.preset} · ${formatDuration(node.duration)}`
        : node.preset;
    case "missing":
      return node.need || `${MISSING_KIND_LABELS[node.mediaKind]} needed`;
    case "chapter":
      return "";
  }
}

function MaterialCardImpl({ data, selected }: NodeProps<StoryFlowNode>) {
  const { node, projectId } = data;
  if (node.kind === "chapter") return null;
  const style = STORY_KIND_STYLES[node.kind];
  const KindIcon = style.icon;
  const visual = node.kind === "video" || node.kind === "picture";
  return (
    <div
      className={cn(
        "w-[184px] overflow-hidden rounded-lg border border-t-2 border-border-input bg-surface text-left shadow-menu",
        style.border,
        node.kind === "missing" && "border-dashed",
        selected && "ring-2 ring-selection",
      )}
      data-story-node={node.id}
    >
      <Handle
        id={HANDLES.attach}
        type="source"
        position={Position.Top}
        className="hf-story-handle-material"
        aria-label="Attach to a chapter"
      />
      {visual && (
        <div className="aspect-video w-full bg-bg-2">
          <Thumb src={cardImage(node, projectId)} node={node} />
        </div>
      )}
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm",
              style.tint,
            )}
          >
            <KindIcon size={11} weight="bold" className={style.text} aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-step-11 font-semibold text-text-0">
            {node.title}
          </span>
          <Marks node={node} />
        </div>
        <p className="truncate text-step-10 text-text-3" title={materialLine(node)}>
          <span className={cn("font-medium", style.text)}>{style.label}</span> ·{" "}
          {materialLine(node)}
        </p>
        <SyncBadges badges={data.sync} className="pt-0.5" />
      </div>
    </div>
  );
}

export const ChapterCard = memo(ChapterCardImpl);
export const MaterialCard = memo(MaterialCardImpl);

/** React Flow's node types; module-level so the canvas never re-registers them. */
export const STORY_NODE_TYPES = { chapter: ChapterCard, material: MaterialCard };
