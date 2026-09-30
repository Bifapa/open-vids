import { Plus, Trash } from "@phosphor-icons/react";
import {
  CHAPTER_STATUSES,
  STORY_NARRATIVE_ROLES,
  type ChapterNode,
  type StoryGraph,
  type StoryMaterialKind,
  type StoryNodeFacts,
  type StorySourceRange,
  type StorySyncReport,
} from "@hyperframes/agent-protocol";
import { Button, IconButton, Input, Select } from "../components/ui";
import { ChapterTimelineSection } from "./ChapterTimelineSection";
import {
  EditedChips,
  Field,
  Section,
  TextAreaField,
  TimeField,
  ToggleRow,
} from "./inspectorFields";
import type { StorySelection } from "./storyStore";
import { fileName, formatDuration } from "./storyFormat";
import {
  CHAPTER_STATUS_LABELS,
  FIELD_LABELS,
  NARRATIVE_ROLE_LABELS,
  PLACEMENT_LABELS,
  STORY_KIND_STYLES,
} from "./storyKinds";
import type { StoryLibrary } from "./useStoryLibrary";

export interface ChapterInspectorProps {
  chapter: ChapterNode;
  graph: StoryGraph;
  facts: StoryNodeFacts | undefined;
  /** The Story ↔ timeline report the chapter's Timeline block reads. */
  sync: StorySyncReport | null;
  library: StoryLibrary;
  readOnly: boolean;
  onChange: (next: ChapterNode) => void;
  onSelect: (selection: StorySelection) => void;
  /** Opens the rebuild impact for this chapter's section only. */
  onRebuild: (chapter: string) => void;
}

/** The chapter's attached materials of the given kinds, as clickable rows. */
function Attached({
  graph,
  chapterId,
  kinds,
  onSelect,
}: {
  graph: StoryGraph;
  chapterId: string;
  kinds: readonly StoryMaterialKind[];
  onSelect: (selection: StorySelection) => void;
}) {
  const rows = graph.attachments.flatMap((attachment) => {
    if (attachment.chapter !== chapterId) return [];
    const node = graph.nodes.find((candidate) => candidate.id === attachment.node);
    if (!node || node.kind === "chapter" || !kinds.includes(node.kind)) return [];
    return [{ attachment, node }];
  });
  if (rows.length === 0) return <p className="text-step-10 text-text-4">Nothing attached.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map(({ attachment, node }) => {
        const style = STORY_KIND_STYLES[node.kind];
        const KindIcon = style.icon;
        return (
          <li key={attachment.id}>
            <button
              type="button"
              onClick={() => onSelect({ nodes: [node.id], edges: [] })}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-step-11 text-text-1 outline-hidden hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
            >
              <KindIcon size={12} className={style.text} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              <span className="shrink-0 text-step-10 text-text-3">
                {attachment.offset !== null
                  ? `at ${formatDuration(attachment.offset)}`
                  : PLACEMENT_LABELS[attachment.placement]}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RangeRow({
  range,
  index,
  sources,
  disabled,
  onChange,
  onRemove,
}: {
  range: StorySourceRange;
  index: number;
  sources: string[];
  disabled: boolean;
  onChange: (next: StorySourceRange) => void;
  onRemove: () => void;
}) {
  const options = (sources.includes(range.source) ? sources : [range.source, ...sources]).map(
    (path) => ({ value: path, label: fileName(path) }),
  );
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-bg-2 p-1.5">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Select
            label={`Range ${index + 1} source`}
            value={range.source}
            options={options}
            disabled={disabled}
            onCommit={(source) => onChange({ ...range, source, segment: null })}
          />
        </div>
        <IconButton
          aria-label={`Remove range ${index + 1}`}
          size="sm"
          disabled={disabled}
          icon={<Trash size={12} aria-hidden />}
          onClick={onRemove}
        />
      </div>
      <div className="flex items-center gap-1">
        <div className="w-22 shrink-0">
          <TimeField
            label={`Range ${index + 1} from`}
            value={range.from}
            precise
            disabled={disabled}
            validate={(from) => from < range.to}
            onCommit={(from) => from !== null && onChange({ ...range, from, segment: null })}
          />
        </div>
        <span className="text-text-4">–</span>
        <div className="w-22 shrink-0">
          <TimeField
            label={`Range ${index + 1} to`}
            value={range.to}
            precise
            disabled={disabled}
            validate={(to) => to > range.from}
            onCommit={(to) => to !== null && onChange({ ...range, to, segment: null })}
          />
        </div>
        {range.segment && (
          <span
            className="ml-auto truncate rounded-sm bg-hover px-1.5 py-0.5 font-mono text-step-10 text-text-2"
            title="Analysis segment this range came from"
          >
            {range.segment}
          </span>
        )}
      </div>
    </li>
  );
}

export function ChapterInspector({
  chapter,
  graph,
  facts,
  sync,
  library,
  readOnly,
  onChange,
  onSelect,
  onRebuild,
}: ChapterInspectorProps) {
  const edited = new Set(chapter.userEdited);
  const set = <K extends keyof ChapterNode>(key: K, value: ChapterNode[K]) =>
    onChange({ ...chapter, [key]: value });
  const sources = library.assets
    .filter((asset) => asset.kind === "video" || asset.kind === "audio")
    .map((asset) => asset.path);
  const ranges = chapter.sourceRanges;
  const setRanges = (next: StorySourceRange[]) => set("sourceRanges", next);
  const material = facts?.materialDuration;

  const addRange = () => {
    const source = ranges.at(-1)?.source ?? sources[0];
    if (!source) return;
    const from = ranges.at(-1)?.source === source ? (ranges.at(-1)?.to ?? 0) : 0;
    setRanges([...ranges, { source, from, to: from + 10, segment: null }]);
  };

  return (
    <>
      <Section title="Chapter">
        <ToggleRow
          label="Locked"
          description="The agent will not change this chapter or its attachments."
          checked={chapter.locked}
          disabled={readOnly}
          onCommit={(locked) => set("locked", locked)}
        />
        <EditedChips fields={chapter.userEdited} labels={FIELD_LABELS} />
        <Field label="Title" edited={edited.has("title")}>
          <Input
            aria-label="Title"
            value={chapter.title}
            disabled={readOnly}
            onCommit={(title) => title.trim() && set("title", title.trim())}
          />
        </Field>
        <Field label="Purpose" edited={edited.has("purpose")}>
          <Input
            aria-label="Purpose"
            value={chapter.purpose}
            disabled={readOnly}
            placeholder="What this chapter does for the story"
            onCommit={(purpose) => set("purpose", purpose)}
          />
        </Field>
        <Field label="Description" edited={edited.has("description")}>
          <TextAreaField
            label="Description"
            value={chapter.description}
            disabled={readOnly}
            onCommit={(description) => set("description", description)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Duration"
            edited={edited.has("estimatedDuration")}
            hint={
              material !== undefined && material !== null
                ? `A-roll ${formatDuration(material)}`
                : undefined
            }
          >
            <TimeField
              label="Estimated duration"
              value={chapter.estimatedDuration}
              disabled={readOnly}
              onCommit={(seconds) => seconds !== null && set("estimatedDuration", seconds)}
            />
          </Field>
          <Field label="Role" edited={edited.has("narrativeRole")}>
            <Select
              label="Narrative role"
              value={chapter.narrativeRole}
              disabled={readOnly}
              options={STORY_NARRATIVE_ROLES.map((role) => ({
                value: role,
                label: NARRATIVE_ROLE_LABELS[role],
              }))}
              onCommit={(role) => {
                const next = STORY_NARRATIVE_ROLES.find((candidate) => candidate === role);
                if (next) set("narrativeRole", next);
              }}
            />
          </Field>
        </div>
        <Field label="Status" edited={edited.has("status")}>
          <Select
            label="Status"
            value={chapter.status}
            disabled={readOnly}
            options={CHAPTER_STATUSES.map((status) => ({
              value: status,
              label: CHAPTER_STATUS_LABELS[status],
            }))}
            onCommit={(status) => {
              const next = CHAPTER_STATUSES.find((candidate) => candidate === status);
              if (next) set("status", next);
            }}
          />
        </Field>
      </Section>

      <ChapterTimelineSection
        chapter={chapter.id}
        report={sync}
        facts={facts}
        readOnly={readOnly}
        onRebuild={onRebuild}
      />

      <Section
        title="A-roll"
        aside={
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={12} aria-hidden />}
            disabled={readOnly || (sources.length === 0 && ranges.length === 0)}
            onClick={addRange}
          >
            Range
          </Button>
        }
      >
        <Field label="Intent" edited={edited.has("aRoll")}>
          <Input
            aria-label="A-roll intent"
            value={chapter.aRoll}
            disabled={readOnly}
            placeholder="Who or what carries the chapter"
            onCommit={(aRoll) => set("aRoll", aRoll)}
          />
        </Field>
        <Field label="Source ranges" edited={edited.has("sourceRanges")}>
          {ranges.length === 0 ? (
            <p className="text-step-10 text-text-4">
              No A-roll yet: the chapter fills its duration with visuals.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {ranges.map((range, index) => (
                <RangeRow
                  key={`${index}-${range.source}`}
                  range={range}
                  index={index}
                  sources={sources}
                  disabled={readOnly}
                  onChange={(next) =>
                    setRanges(ranges.map((item, at) => (at === index ? next : item)))
                  }
                  onRemove={() => setRanges(ranges.filter((_, at) => at !== index))}
                />
              ))}
            </ol>
          )}
        </Field>
        <ToggleRow
          label="Captions"
          description="Word-synced captions from the transcript."
          checked={chapter.captions}
          edited={edited.has("captions")}
          disabled={readOnly}
          onCommit={(captions) => set("captions", captions)}
        />
      </Section>

      <Section title="B-roll">
        <Field label="Intent" edited={edited.has("bRoll")}>
          <Input
            aria-label="B-roll intent"
            value={chapter.bRoll}
            disabled={readOnly}
            onCommit={(bRoll) => set("bRoll", bRoll)}
          />
        </Field>
        <Attached
          graph={graph}
          chapterId={chapter.id}
          kinds={["video", "picture", "missing"]}
          onSelect={onSelect}
        />
      </Section>

      <Section title="Graphics">
        <Field label="Intent" edited={edited.has("graphics")}>
          <Input
            aria-label="Graphics intent"
            value={chapter.graphics}
            disabled={readOnly}
            onCommit={(graphics) => set("graphics", graphics)}
          />
        </Field>
        <Attached graph={graph} chapterId={chapter.id} kinds={["motion"]} onSelect={onSelect} />
      </Section>

      <Section title="Audio">
        <Field label="Intent" edited={edited.has("audio")}>
          <Input
            aria-label="Audio intent"
            value={chapter.audio}
            disabled={readOnly}
            onCommit={(audio) => set("audio", audio)}
          />
        </Field>
        <Attached graph={graph} chapterId={chapter.id} kinds={["music"]} onSelect={onSelect} />
      </Section>
    </>
  );
}
