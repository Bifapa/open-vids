import { useMemo } from "react";
import { Trash } from "@phosphor-icons/react";
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
import { ChapterInspector } from "./ChapterInspector";
import { Field, Section, TextAreaField, TimeField } from "./inspectorFields";
import { MaterialInspector } from "./MaterialInspector";
import { useStoryServices, useStoryStore } from "./storyContext";
import { formatAge, formatDuration } from "./storyFormat";
import { removeItems, replaceAttachment, replaceEdge, replaceNode } from "./storyGraphOps";
import { PLACEMENT_LABELS } from "./storyKinds";
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
      className="self-start"
      icon={<Trash size={12} aria-hidden />}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

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
  const order = useMemo(() => storyOrder(graph), [graph]);
  const chapters = new Map(graph.nodes.filter(isChapter).map((node) => [node.id, node]));
  const total = order.chapters.reduce(
    (sum, id) => sum + (chapters.get(id)?.estimatedDuration ?? 0),
    0,
  );
  const now = Date.now();
  return (
    <>
      <Section title="Story">
        <Field label="Title">
          <Input
            aria-label="Story title"
            value={graph.title}
            disabled={readOnly}
            onCommit={(title) =>
              title.trim() && onGraph((current) => ({ ...current, title: title.trim() }))
            }
          />
        </Field>
        <Field label="Brief">
          <TextAreaField
            label="Story brief"
            value={graph.brief}
            disabled={readOnly}
            placeholder="What the video should achieve, in your words"
            onCommit={(brief) => onGraph((current) => ({ ...current, brief }))}
          />
        </Field>
      </Section>
      <Section
        title="Play order"
        aside={
          <span className="text-step-10 tabular-nums text-text-3">
            {order.chapters.length} chapters · {formatDuration(total)}
          </span>
        }
      >
        {order.chapters.length === 0 ? (
          <p className="text-step-10 text-text-4">No chapters yet.</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {order.chapters.map((id, index) => {
              const chapter = chapters.get(id);
              if (!chapter) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onSelect({ nodes: [id], edges: [] })}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-step-11 text-text-1 outline-hidden hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="w-5 shrink-0 text-right tabular-nums text-text-3">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                    <span className="shrink-0 tabular-nums text-text-3">
                      {formatDuration(chapter.estimatedDuration)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {order.notes.map((note) => (
          <p key={note} className="text-step-10 text-container">
            {note}
          </p>
        ))}
      </Section>
      {(graph.review || graph.build) && (
        <Section title="Last AI passes">
          {graph.review && (
            <div className="flex flex-col gap-0.5">
              <span className="text-step-10 text-text-3">
                Reviewed {formatAge(graph.review.at, now)}
              </span>
              <p className="whitespace-pre-wrap text-step-11 text-text-1">{graph.review.summary}</p>
            </div>
          )}
          {graph.build && (
            <div className="flex flex-col gap-0.5">
              <span className="text-step-10 text-text-3">
                Built {formatAge(graph.build.at, now)} · {formatDuration(graph.build.duration)} into{" "}
                {graph.build.composition}
              </span>
              {graph.build.warnings.map((warning) => (
                <p key={warning} className="text-step-10 text-container">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}
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
  return (
    <Section title="Sequence">
      <p className="text-step-11 text-text-1">
        “{titleOf(graph, edge.from)}” plays right before “{titleOf(graph, edge.to)}”.
      </p>
      <Field label="Transition">
        <Input
          aria-label="Transition"
          value={edge.transition}
          disabled={readOnly}
          placeholder="Match cut on the keyboard, music rise…"
          onCommit={(transition) => onChange({ ...edge, transition })}
        />
      </Field>
      <span className="text-step-10 text-text-3">
        {edge.createdBy === "user" ? "Connected by you" : "Suggested by the agent"}
      </span>
      <DeleteButton label="Disconnect" disabled={readOnly} onClick={onDelete} />
    </Section>
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
  return (
    <Section title="Attachment">
      <p className="text-step-11 text-text-1">
        “{titleOf(graph, attachment.node)}” in “{titleOf(graph, attachment.chapter)}”.
      </p>
      <Field label="Placement">
        <Select
          label="Placement"
          value={attachment.placement}
          disabled={readOnly || attachment.offset !== null}
          options={ATTACHMENT_PLACEMENTS.map((placement) => ({
            value: placement,
            label: PLACEMENT_LABELS[placement],
          }))}
          onCommit={(value) => {
            const placement = ATTACHMENT_PLACEMENTS.find((candidate) => candidate === value);
            if (placement) onChange({ ...attachment, placement });
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="At" hint="From the chapter start; overrides placement.">
          <TimeField
            label="Offset"
            value={attachment.offset}
            optional
            placeholder="–"
            disabled={readOnly}
            onCommit={(offset) => onChange({ ...attachment, offset })}
          />
        </Field>
        <Field label="Length" hint="Empty: the material’s own.">
          <TimeField
            label="Attachment length"
            value={attachment.duration}
            optional
            placeholder="–"
            disabled={readOnly}
            validate={(seconds) => seconds > 0}
            onCommit={(duration) => onChange({ ...attachment, duration })}
          />
        </Field>
      </div>
      <span className="text-step-10 text-text-3">
        {attachment.createdBy === "user" ? "Attached by you" : "Suggested by the agent"}
      </span>
      <DeleteButton label="Detach" disabled={readOnly} onClick={onDelete} />
    </Section>
  );
}

/** The right side of the Story panel: whatever is selected, else the story itself. */
export function StoryInspector({ library }: { library: StoryLibrary }) {
  const { store } = useStoryServices();
  const graph = useStoryStore((state) => state.graph);
  const selection = useStoryStore((state) => state.selection);
  const facts = useStoryStore((state) => state.facts);
  const readOnly = useStoryStore((state) => state.agentBusy);
  if (!graph) return null;

  const commit = (change: (current: StoryGraph) => StoryGraph) => store.getState().commit(change);
  const select = (next: StorySelection) => store.getState().select(next);
  const remove = (ids: string[]) => commit((current) => removeItems(current, ids));
  const onNode = (next: StoryNode) => commit((current) => replaceNode(current, next));
  const count = selection.nodes.length + selection.edges.length;

  let body;
  if (count === 0) {
    body = <Overview graph={graph} readOnly={readOnly} onGraph={commit} onSelect={select} />;
  } else if (count > 1) {
    body = (
      <Section title="Selection">
        <p className="text-step-11 text-text-1">{count} items selected.</p>
        <DeleteButton
          label="Delete"
          disabled={readOnly}
          onClick={() => remove([...selection.nodes, ...selection.edges])}
        />
      </Section>
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
            library={library}
            readOnly={readOnly}
            onChange={onNode}
            onSelect={select}
          />
        ) : (
          <MaterialInspector
            node={node}
            graph={graph}
            library={library}
            readOnly={readOnly}
            onChange={onNode}
            onSelect={select}
          />
        )}
        <div className="px-3 py-3">
          <DeleteButton label="Delete node" disabled={readOnly} onClick={() => remove([node.id])} />
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
          onChange={(next) => commit((current) => replaceEdge(current, next))}
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
      aria-label="Story inspector"
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-border bg-bg-1"
    >
      {body}
    </aside>
  );
}
