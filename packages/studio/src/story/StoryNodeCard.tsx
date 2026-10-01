import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CaretRight, Check, LockSimple, PencilSimple, WarningCircle } from "@phosphor-icons/react";
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
  materialRole,
} from "./storyKinds";
import { SyncBadges } from "./SyncBadges";
import {
  FindWithResearchButton,
  ResolvedCardLine,
  resolutionOf,
  useStoryResearch,
} from "./storyResearch";

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

export function cardImage(node: StoryNode, projectId: string): string | null {
  if (node.kind === "picture") return projectFileUrl(projectId, node.asset);
  const frame = cardFrame(node);
  return frame ? storyFrameUrl(projectId, frame.source, frame.time) : null;
}

/** A card's picture, or the kind's glyph when there is none (music, motion) or it fails to load. */
export function Thumb({ src, node }: { src: string | null; node: StoryNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const KindIcon = STORY_KIND_STYLES[node.kind].icon;
  if (!src || failedSrc === src) {
    return (
      <span className="hf-sg-placeholder">
        <KindIcon size={node.kind === "chapter" ? 22 : 14} aria-hidden />
      </span>
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
    />
  );
}

/** Lock and "edited by you" marks, shared by both card kinds. Neutral ink: the accent is selection only. */
function Marks({ node, lock = true }: { node: StoryNode; lock?: boolean }) {
  const edited = node.userEdited.map((field) => FIELD_LABELS[field] ?? field);
  const byYou = node.createdBy === "user" || edited.length > 0;
  if (!byYou && !(lock && node.locked)) return null;
  return (
    <span className="hf-sg-marks">
      {byYou && (
        <span
          role="img"
          title={edited.length > 0 ? `Edited by you: ${edited.join(", ")}` : "Added by you"}
          aria-label={edited.length > 0 ? "Edited by you" : "Added by you"}
        >
          <PencilSimple size={11} aria-hidden />
        </span>
      )}
      {lock && node.locked && (
        <LockSimple size={11} weight="fill" aria-label="Locked: the agent will not change it" />
      )}
    </span>
  );
}

function ChapterCardImpl({ data, selected }: NodeProps<StoryFlowNode>) {
  const { node, facts, projectId, number } = data;
  if (node.kind !== "chapter") return null;
  const onTimeline = facts?.timeline ?? null;
  const material = facts?.materialDuration;
  const role = NARRATIVE_ROLE_LABELS[node.narrativeRole];
  return (
    <div
      className={cn(
        "hf-sg-node hf-sg-ch hf-k-chapter",
        selected && "hf-sel",
        node.locked && "hf-locked",
      )}
      data-story-node={node.id}
    >
      <Handle
        id={HANDLES.sequenceIn}
        type="target"
        position={Position.Left}
        className="hf-story-handle-sequence hf-story-nodrag"
        aria-label="Plays after"
      />
      <Handle
        id={HANDLES.sequenceOut}
        type="source"
        position={Position.Right}
        className="hf-story-handle-sequence hf-story-nodrag"
        aria-label="Plays before"
      />
      <Handle
        id={HANDLES.material}
        type="target"
        position={Position.Bottom}
        className="hf-story-handle-material hf-story-nodrag"
        aria-label="Attach material"
      />
      <div className="hf-sg-frame">
        <Thumb src={cardImage(node, projectId)} node={node} />
        <span className="hf-sg-num">{number !== null ? String(number).padStart(2, "0") : "–"}</span>
        <span className="hf-sg-flags">
          {node.status === "needs_material" && (
            <span className="hf-sg-flag hf-warn">
              <span className="hf-sg-flag-label">Needs material</span>
            </span>
          )}
          <SyncBadges badges={data.sync} variant="flag" />
          {onTimeline && data.sync.length === 0 && (
            <span
              className="hf-sg-flag hf-ok"
              title={`On the timeline ${formatDuration(onTimeline.start)}–${formatDuration(onTimeline.end)} (${onTimeline.clips} clips)`}
            >
              <Check weight="bold" aria-label="On the timeline" />
            </span>
          )}
          {node.locked && (
            <span className="hf-sg-flag hf-lock" title="Locked: the agent will not change it">
              <LockSimple weight="fill" aria-label="Locked" />
            </span>
          )}
        </span>
      </div>
      <div className="hf-sg-body">
        <div className="hf-sg-row">
          <span className="hf-sg-title" title={node.title}>
            {node.title}
          </span>
          <Marks node={node} lock={false} />
          <span
            className="hf-sg-dur"
            title={
              material !== undefined && material !== null
                ? `Planned ${formatDuration(node.estimatedDuration)} · A-roll ${formatDuration(material)} after cleanup`
                : `Planned ${formatDuration(node.estimatedDuration)}`
            }
          >
            {formatDuration(node.estimatedDuration)}
          </span>
        </div>
        <p className="hf-sg-desc">
          <b>{node.status === "proposed" ? `${role} · proposed` : role}</b> ·{" "}
          {node.description || node.purpose || "No description yet"}
        </p>
      </div>
    </div>
  );
}

/** The meta line after the role: length, still, track, preset or what is needed. */
function materialDetail(node: StoryNode): string {
  switch (node.kind) {
    case "video":
      return node.sourceOut !== null
        ? formatDuration(node.sourceOut - node.sourceIn)
        : fileName(node.asset);
    case "picture":
      return "Still";
    case "music":
      return node.asset ? fileName(node.asset) : "No track chosen yet";
    case "motion":
      return node.duration !== null ? formatDuration(node.duration) : node.preset;
    case "missing":
      return node.neededDuration !== null
        ? `${MISSING_KIND_LABELS[node.mediaKind]} · ${formatDuration(node.neededDuration)}`
        : MISSING_KIND_LABELS[node.mediaKind];
    case "chapter":
      return "";
  }
}

/** The full story behind a material card, for its tooltip. */
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
  const { node, projectId, uses } = data;
  const research = useStoryResearch();
  if (node.kind === "chapter") return null;
  const resolution = resolutionOf(node);
  const style = STORY_KIND_STYLES[node.kind];
  const KindIcon = style.icon;
  const missing = node.kind === "missing";
  const find = missing && research ? research : null;
  const first = uses[0];
  return (
    <div
      className={cn(
        "hf-sg-node hf-sg-m",
        style.kindClass,
        missing && "hf-sg-miss",
        selected && "hf-sel",
      )}
      data-story-node={node.id}
    >
      <Handle
        id={HANDLES.attach}
        type="source"
        position={Position.Top}
        className="hf-story-handle-material hf-story-nodrag"
        aria-label="Attach to a chapter"
      />
      <div className="hf-sg-mrow" title={materialLine(node)}>
        <span className="hf-sg-thumb">
          {missing ? (
            <WarningCircle size={14} aria-hidden />
          ) : (
            <>
              <Thumb src={cardImage(node, projectId)} node={node} />
              <span className="hf-sg-type">
                <KindIcon size={10} weight="bold" aria-hidden />
              </span>
            </>
          )}
        </span>
        <span className="hf-sg-txt">
          <span className="hf-sg-name">{node.title}</span>
          <span className="hf-sg-meta">
            <b>{materialRole(node)}</b> · {materialDetail(node)}
          </span>
        </span>
        <Marks node={node} />
      </div>
      {node.kind === "motion" &&
        (first ? (
          <div className="hf-sg-use">
            <CaretRight size={10} weight="bold" aria-hidden />
            Use in <b>{first.number !== null ? String(first.number).padStart(2, "0") : "–"}</b>
            <span>
              {first.title}
              {uses.length > 1 ? ` +${uses.length - 1}` : ""}
            </span>
          </div>
        ) : (
          <div className="hf-sg-use hf-idle">Connect to a chapter to use it</div>
        ))}
      {(resolution || find || data.sync.length > 0) && (
        <div className="hf-sg-extra">
          {resolution && (
            <ResolvedCardLine node={node} resolution={resolution} research={research} />
          )}
          {find && node.kind === "missing" && (
            <FindWithResearchButton node={node} research={find} block />
          )}
          <SyncBadges badges={data.sync} />
        </div>
      )}
    </div>
  );
}

export const ChapterCard = memo(ChapterCardImpl);
export const MaterialCard = memo(MaterialCardImpl);

/** React Flow's node types; module-level so the canvas never re-registers them. */
export const STORY_NODE_TYPES = { chapter: ChapterCard, material: MaterialCard };
