import { useMemo } from "react";
import { ArrowRight, LinkSimple, Trash } from "@phosphor-icons/react";
import {
  ATTACHMENT_PLACEMENTS,
  isChapter,
  storyOrder,
  type StoryAttachment,
  type StoryEdge,
  type StoryGraph,
  type StoryNode,
} from "@hyperframes/agent-protocol";
import { Button, Input, Select } from "../components/ui";
import { useTranslation } from "../i18n";
import { ChapterInspector } from "./ChapterInspector";
import {
  Field,
  HintNote,
  InspectorHead,
  Section,
  TextAreaField,
  TimeField,
} from "./inspectorFields";
import { MaterialInspector } from "./MaterialInspector";
import { useStoryServices, useStoryStore } from "./storyContext";
import { formatAge, formatDuration } from "./storyFormat";
import { removeItems, replaceAttachment, replaceEdge, replaceNode } from "./storyGraphOps";
import { PLACEMENT_KEYS, STORY_KIND_STYLES } from "./storyKinds";
import { Slot } from "./StorySlots";
import type { StorySelection } from "./storyStore";
import type { StoryLibrary } from "./useStoryLibrary";

function titleOf(graph: StoryGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.title ?? id;
}

function DeleteButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="w-full"
      icon={<Trash size={12} aria-hidden />}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** Nothing selected: the story itself (prototype's "Story Graph" inspector). */
function Overview({
  graph,
  readOnly,
  onGraph,
  onSelect,
}: {
  graph: StoryGraph;
  readOnly: boolean;
  onGraph: (change: (graph: StoryGraph) => StoryGraph) => void;
  onSelect: (selection: StorySelection) => void;
}) {
  const { t } = useTranslation();
  const order = useMemo(() => storyOrder(graph), [graph]);
  const chapters = new Map(graph.nodes.filter(isChapter).map((node) => [node.id, node]));
  const total = order.chapters.reduce(
    (sum, id) => sum + (chapters.get(id)?.estimatedDuration ?? 0),
    0,
  );
  const missing = graph.nodes.filter((node) => node.kind === "missing").length;
  const locked = graph.nodes.filter((node) => node.locked).length;
  const now = Date.now();
  return (
    <>
      <InspectorHead
        icon={STORY_KIND_STYLES.chapter.icon}
        chip={STORY_KIND_STYLES.chapter.chip}
        name={t("story.toolbar.title")}
        sub={t("story.inspector.overviewSub", {
          count: order.chapters.length,
          duration: formatDuration(total),
        })}
      />
      <Section title={t("story.inspector.section.story")}>
        <Field label={t("story.field.title")}>
          <Input
            aria-label={t("story.inspector.storyTitle")}
            value={graph.title}
            disabled={readOnly}
            onCommit={(title) =>
              title.trim() && onGraph((current) => ({ ...current, title: title.trim() }))
            }
          />
        </Field>
        <Field label={t("story.inspector.brief")} top>
          <TextAreaField
            label={t("story.inspector.storyBrief")}
            value={graph.brief}
            disabled={readOnly}
            placeholder={t("story.inspector.briefPlaceholder")}
            onCommit={(brief) => onGraph((current) => ({ ...current, brief }))}
          />
        </Field>
        <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
          <dt className="text-fg-3">{t("story.inspector.nodes")}</dt>
          <dd className="m-0 tabular-nums text-fg">{graph.nodes.length}</dd>
          <dt className="text-fg-3">{t("story.inspector.missing")}</dt>
          <dd className="m-0 text-fg">
            {missing === 0
              ? t("story.inspector.none")
              : t("story.inspector.missingCount", { count: missing })}
          </dd>
          <dt className="text-fg-3">{t("story.inspector.locked")}</dt>
          <dd className="m-0 text-fg">
            {locked === 0
              ? t("story.inspector.none")
              : t("story.inspector.lockedCount", { count: locked })}
          </dd>
        </dl>
      </Section>
      <Section title={t("story.inspector.playOrder")}>
        {order.chapters.length === 0 ? (
          <p className="text-sm text-fg-3">{t("story.inspector.noChapters")}</p>
        ) : (
          <ol className="grid gap-0.5">
            {order.chapters.map((id, index) => {
              const chapter = chapters.get(id);
              if (!chapter) return null;
              return (
                <Slot
                  key={id}
                  thumb={
                    <span className="flex h-full w-full items-center justify-center bg-surface-2 font-mono text-num font-semibold text-fg">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  }
                  name={chapter.title}
                  detail={formatDuration(chapter.estimatedDuration)}
                  onOpen={() => onSelect({ nodes: [id], edges: [] })}
                />
              );
            })}
          </ol>
        )}
        {order.notes.map((note) => (
          <HintNote key={note} icon={LinkSimple} tone="warning">
            {note}
          </HintNote>
        ))}
      </Section>
      {(graph.review || graph.build) && (
        <Section title={t("story.inspector.lastPasses")}>
          {graph.review && (
            <div className="grid gap-0.5">
              <span className="text-xs text-fg-3">
                {t("story.toolbar.reviewed", { age: formatAge(graph.review.at, now) })}
              </span>
              <p className="text-sm leading-[17px] whitespace-pre-wrap text-fg-2">
                {graph.review.summary}
              </p>
            </div>
          )}
          {graph.build && (
            <div className="grid gap-0.5">
              <span className="text-xs text-fg-3">
                {t("story.inspector.builtInto", {
                  age: formatAge(graph.build.at, now),
                  duration: formatDuration(graph.build.duration),
                  composition: graph.build.composition,
                })}
              </span>
              {graph.build.warnings.map((warning) => (
                <p key={warning} className="text-xs text-warning">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}
      <p className="p-3 text-sm leading-[17px] text-pretty text-fg-3">
        {t("story.inspector.overviewHint")}
      </p>
    </>
  );
}

function EdgeInspector({
  edge,
  graph,
  readOnly,
  onChange,
  onDelete,
}: {
  edge: StoryEdge;
  graph: StoryGraph;
  readOnly: boolean;
  onChange: (next: StoryEdge) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <InspectorHead
        icon={ArrowRight}
        chip={STORY_KIND_STYLES.chapter.chip}
        name={t("story.inspector.sequence")}
        sub={`${titleOf(graph, edge.from)} → ${titleOf(graph, edge.to)}`}
      />
      <Section title={t("story.inspector.sequence")}>
        <p className="text-sm leading-[17px] text-fg-2">
          {t("story.inspector.sequenceNote", {
            from: titleOf(graph, edge.from),
            to: titleOf(graph, edge.to),
          })}
        </p>
        <Field label={t("story.inspector.transition")}>
          <Input
            aria-label={t("story.inspector.transition")}
            value={edge.transition}
            disabled={readOnly}
            placeholder={t("story.inspector.transitionPlaceholder")}
            onCommit={(transition) => onChange({ ...edge, transition })}
          />
        </Field>
        <span className="text-xs text-fg-3">
          {edge.createdBy === "user"
            ? t("story.inspector.connectedByYou")
            : t("story.inspector.suggestedByAgent")}
        </span>
        <DeleteButton
          label={t("story.inspector.disconnect")}
          disabled={readOnly}
          onClick={onDelete}
        />
      </Section>
    </>
  );
}

function AttachmentInspector({
  attachment,
  graph,
  readOnly,
  onChange,
  onDelete,
}: {
  attachment: StoryAttachment;
  graph: StoryGraph;
  readOnly: boolean;
  onChange: (next: StoryAttachment) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const material = graph.nodes.find((node) => node.id === attachment.node);
  const style = STORY_KIND_STYLES[material?.kind ?? "chapter"];
  return (
    <>
      <InspectorHead
        icon={style.icon}
        chip={style.chip}
        name={titleOf(graph, attachment.node)}
        sub={t("story.inspector.attachedTo", { title: titleOf(graph, attachment.chapter) })}
      />
      <Section title={t("story.inspector.attachment")}>
        <Field label={t("story.inspector.placement")}>
          <Select
            label={t("story.inspector.placement")}
            value={attachment.placement}
            disabled={readOnly || attachment.offset !== null}
            options={ATTACHMENT_PLACEMENTS.map((placement) => ({
              value: placement,
              label: t(PLACEMENT_KEYS[placement]),
            }))}
            onCommit={(value) => {
              const placement = ATTACHMENT_PLACEMENTS.find((candidate) => candidate === value);
              if (placement) onChange({ ...attachment, placement });
            }}
          />
        </Field>
        <Field label={t("story.inspector.at")} hint={t("story.inspector.atHint")}>
          <TimeField
            label={t("story.inspector.offset")}
            value={attachment.offset}
            optional
            placeholder="–"
            disabled={readOnly}
            onCommit={(offset) => onChange({ ...attachment, offset })}
          />
        </Field>
        <Field label={t("story.inspector.length")} hint={t("story.inspector.lengthHint")}>
          <TimeField
            label={t("story.inspector.attachmentLength")}
            value={attachment.duration}
            optional
            placeholder="–"
            disabled={readOnly}
            validate={(seconds) => seconds > 0}
            onCommit={(duration) => onChange({ ...attachment, duration })}
          />
        </Field>
        <span className="text-xs text-fg-3">
          {attachment.createdBy === "user"
            ? t("story.inspector.attachedByYou")
            : t("story.inspector.suggestedByAgent")}
        </span>
        <DeleteButton label={t("story.inspector.detach")} disabled={readOnly} onClick={onDelete} />
      </Section>
    </>
  );
}

/** The right side of the Story panel: whatever is selected, else the story itself. */
export function StoryInspector({
  library,
  onRebuildSection,
}: {
  library: StoryLibrary;
  /** Opens the rebuild impact for one chapter's section. */
  onRebuildSection: (chapter: string) => void;
}) {
  const { t } = useTranslation();
  const { store } = useStoryServices();
  const graph = useStoryStore((state) => state.graph);
  const selection = useStoryStore((state) => state.selection);
  const facts = useStoryStore((state) => state.facts);
  const sync = useStoryStore((state) => state.sync);
  const readOnly = useStoryStore((state) => state.agentBusy);
  if (!graph) return null;

  const commit = (change: (current: StoryGraph) => StoryGraph) => store.getState().commit(change);
  const select = (next: StorySelection) => store.getState().select(next);
  const remove = (ids: string[]) => commit((current) => removeItems(current, ids));
  const onNode = (next: StoryNode) => commit((current) => replaceNode(current, next));
  const onEdge = (next: StoryEdge) => commit((current) => replaceEdge(current, next));
  const count = selection.nodes.length + selection.edges.length;

  let body;
  if (count === 0) {
    body = <Overview graph={graph} readOnly={readOnly} onGraph={commit} onSelect={select} />;
  } else if (count > 1) {
    body = (
      <>
        <InspectorHead
          icon={STORY_KIND_STYLES.chapter.icon}
          chip={STORY_KIND_STYLES.chapter.chip}
          name={t("story.inspector.selection")}
          sub={t("story.inspector.itemsSelected", { count })}
        />
        <div className="p-3">
          <DeleteButton
            label={t("common.delete")}
            disabled={readOnly}
            onClick={() => remove([...selection.nodes, ...selection.edges])}
          />
        </div>
      </>
    );
  } else if (selection.nodes.length === 1) {
    const node = graph.nodes.find((candidate) => candidate.id === selection.nodes[0]);
    if (!node) return null;
    body = (
      <>
        {isChapter(node) ? (
          <ChapterInspector
            chapter={node}
            graph={graph}
            facts={facts[node.id]}
            sync={sync}
            library={library}
            readOnly={readOnly}
            onChange={onNode}
            onEdge={onEdge}
            onRemove={remove}
            onSelect={select}
            onRebuild={onRebuildSection}
          />
        ) : (
          <MaterialInspector
            node={node}
            graph={graph}
            library={library}
            readOnly={readOnly}
            onChange={onNode}
            onRemove={remove}
            onSelect={select}
          />
        )}
        <div className="p-3">
          <DeleteButton
            label={t("story.inspector.deleteNode")}
            disabled={readOnly}
            onClick={() => remove([node.id])}
          />
        </div>
      </>
    );
  } else {
    const id = selection.edges[0];
    const edge = graph.edges.find((candidate) => candidate.id === id);
    const attachment = graph.attachments.find((candidate) => candidate.id === id);
    if (edge) {
      body = (
        <EdgeInspector
          edge={edge}
          graph={graph}
          readOnly={readOnly}
          onChange={onEdge}
          onDelete={() => remove([edge.id])}
        />
      );
    } else if (attachment) {
      body = (
        <AttachmentInspector
          attachment={attachment}
          graph={graph}
          readOnly={readOnly}
          onChange={(next) => commit((current) => replaceAttachment(current, next))}
          onDelete={() => remove([attachment.id])}
        />
      );
    } else {
      return null;
    }
  }

  return (
    <aside
      aria-label={t("story.inspector.label")}
      className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-bg-0 [scrollbar-color:var(--color-surface-3)_transparent] @max-[760px]/story:w-[264px]"
    >
      {body}
    </aside>
  );
}
