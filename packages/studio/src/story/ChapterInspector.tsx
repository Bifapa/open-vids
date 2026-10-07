import { LockSimple, LockSimpleOpen, Plus, Trash } from "@phosphor-icons/react";
import {
  CHAPTER_STATUSES,
  STORY_NARRATIVE_ROLES,
  isChapter,
  storyOrder,
  type ChapterNode,
  type StoryEdge,
  type StoryGraph,
  type StoryNodeFacts,
  type StorySourceRange,
  type StorySyncReport,
} from "@hyperframes/agent-protocol";
import { Button, IconButton, Input, Select } from "../components/ui";
import { useTranslation } from "../i18n";
import { ChapterTimelineSection } from "./ChapterTimelineSection";
import {
  EditedChips,
  Field,
  HintNote,
  InspectorHead,
  Section,
  TextAreaField,
  TimeField,
  ToggleRow,
} from "./inspectorFields";
import type { StorySelection } from "./storyStore";
import { fileName, formatDuration } from "./storyFormat";
import { CHAPTER_STATUS_KEYS, NARRATIVE_ROLE_KEYS, STORY_KIND_STYLES } from "./storyKinds";
import { AttachedSlots } from "./StorySlots";
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
  /** Edits the sequence link into this chapter (its transition). */
  onEdge: (next: StoryEdge) => void;
  /** Deletes attachments (a slot's detach). */
  onRemove: (ids: string[]) => void;
  onSelect: (selection: StorySelection) => void;
  /** Opens the rebuild impact for this chapter's section only. */
  onRebuild: (chapter: string) => void;
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
  const { t } = useTranslation();
  const options = (sources.includes(range.source) ? sources : [range.source, ...sources]).map(
    (path) => ({ value: path, label: fileName(path) }),
  );
  return (
    <li className="grid gap-1 rounded-md border border-border-subtle bg-bg-1 p-1.5">
      <div className="flex items-center gap-1">
        <span className="flex h-5 w-6 shrink-0 items-center justify-center rounded-xs bg-k-video-h font-mono text-num font-semibold text-clip-ink">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <Select
            label={t("story.chapter.rangeSource", { number: index + 1 })}
            value={range.source}
            options={options}
            disabled={disabled}
            onCommit={(source) => onChange({ ...range, source, segment: null })}
          />
        </div>
        <IconButton
          aria-label={t("story.chapter.rangeRemove", { number: index + 1 })}
          size="xs"
          disabled={disabled}
          icon={<Trash size={12} aria-hidden />}
          onClick={onRemove}
        />
      </div>
      <div className="flex items-center gap-1 pl-7">
        <div className="w-20 shrink-0">
          <TimeField
            label={t("story.chapter.rangeFrom", { number: index + 1 })}
            value={range.from}
            precise
            disabled={disabled}
            validate={(from) => from < range.to}
            onCommit={(from) => from !== null && onChange({ ...range, from, segment: null })}
          />
        </div>
        <span className="text-fg-3">–</span>
        <div className="w-20 shrink-0">
          <TimeField
            label={t("story.chapter.rangeTo", { number: index + 1 })}
            value={range.to}
            precise
            disabled={disabled}
            validate={(to) => to > range.from}
            onCommit={(to) => to !== null && onChange({ ...range, to, segment: null })}
          />
        </div>
        {range.segment && (
          <span
            className="ml-auto truncate rounded-xs bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-2"
            title={t("story.chapter.segmentTip")}
          >
            {range.segment}
          </span>
        )}
      </div>
    </li>
  );
}

/** Where the chapter sits in the planned cut: its number, start and the story's length. */
function placeOf(graph: StoryGraph, chapterId: string) {
  const order = storyOrder(graph).chapters;
  const lengths = new Map(
    graph.nodes.filter(isChapter).map((node) => [node.id, node.estimatedDuration]),
  );
  let start = 0;
  let total = 0;
  for (const id of order) {
    if (id === chapterId) start = total;
    total += lengths.get(id) ?? 0;
  }
  return { index: order.indexOf(chapterId), count: order.length, start, total };
}

export function ChapterInspector({
  chapter,
  graph,
  facts,
  sync,
  library,
  readOnly,
  onChange,
  onEdge,
  onRemove,
  onSelect,
  onRebuild,
}: ChapterInspectorProps) {
  const { t } = useTranslation();
  const edited = new Set(chapter.userEdited);
  const set = <K extends keyof ChapterNode>(key: K, value: ChapterNode[K]) =>
    onChange({ ...chapter, [key]: value });
  const sources = library.assets
    .filter((asset) => asset.kind === "video" || asset.kind === "audio")
    .map((asset) => asset.path);
  const ranges = chapter.sourceRanges;
  const setRanges = (next: StorySourceRange[]) => set("sourceRanges", next);
  const material = facts?.materialDuration;
  const place = placeOf(graph, chapter.id);
  const end = place.start + chapter.estimatedDuration;
  const incoming = graph.edges.find((edge) => edge.to === chapter.id) ?? null;
  const detach = (attachment: string) => onRemove([attachment]);

  const addRange = () => {
    const source = ranges.at(-1)?.source ?? sources[0];
    if (!source) return;
    const from = ranges.at(-1)?.source === source ? (ranges.at(-1)?.to ?? 0) : 0;
    setRanges([...ranges, { source, from, to: from + 10, segment: null }]);
  };

  return (
    <>
      <InspectorHead
        icon={STORY_KIND_STYLES.chapter.icon}
        chip={STORY_KIND_STYLES.chapter.chip}
        number={place.index >= 0 ? String(place.index + 1).padStart(2, "0") : "–"}
        name={chapter.title}
        sub={
          place.index >= 0
            ? t("story.chapter.subtitle", {
                number: place.index + 1,
                count: place.count,
                start: formatDuration(place.start),
                end: formatDuration(end),
              })
            : t("story.chapter.section.chapter")
        }
      />

      <Section title={t("story.chapter.section.chapter")}>
        <EditedChips fields={chapter.userEdited} />
        <Field label={t("story.field.title")} edited={edited.has("title")}>
          <Input
            aria-label={t("story.field.title")}
            value={chapter.title}
            disabled={readOnly}
            onCommit={(title) => title.trim() && set("title", title.trim())}
          />
        </Field>
        <Field label={t("story.chapter.purpose")} edited={edited.has("purpose")} top>
          <TextAreaField
            label={t("story.chapter.purpose")}
            value={chapter.purpose}
            rows={2}
            disabled={readOnly}
            placeholder={t("story.chapter.purposePlaceholder")}
            onCommit={(purpose) => set("purpose", purpose)}
          />
        </Field>
        <Field label={t("story.chapter.summary")} edited={edited.has("description")} top>
          <TextAreaField
            label={t("story.chapter.summary")}
            value={chapter.description}
            rows={2}
            disabled={readOnly}
            placeholder={t("story.chapter.summaryPlaceholder")}
            onCommit={(description) => set("description", description)}
          />
        </Field>
        <Field label={t("story.chapter.role")} edited={edited.has("narrativeRole")}>
          <Select
            label={t("story.chapter.narrativeRole")}
            value={chapter.narrativeRole}
            disabled={readOnly}
            options={STORY_NARRATIVE_ROLES.map((role) => ({
              value: role,
              label: t(NARRATIVE_ROLE_KEYS[role]),
            }))}
            onCommit={(role) => {
              const next = STORY_NARRATIVE_ROLES.find((candidate) => candidate === role);
              if (next) set("narrativeRole", next);
            }}
          />
        </Field>
        <Field label={t("story.field.status")} edited={edited.has("status")}>
          <Select
            label={t("story.field.status")}
            value={chapter.status}
            disabled={readOnly}
            options={CHAPTER_STATUSES.map((status) => ({
              value: status,
              label: t(CHAPTER_STATUS_KEYS[status]),
            }))}
            onCommit={(status) => {
              const next = CHAPTER_STATUSES.find((candidate) => candidate === status);
              if (next) set("status", next);
            }}
          />
        </Field>
      </Section>

      <Section title={t("story.field.aRoll")}>
        <Field label={t("story.chapter.intent")} edited={edited.has("aRoll")}>
          <Input
            aria-label={t("story.chapter.aRollIntent")}
            value={chapter.aRoll}
            disabled={readOnly}
            placeholder={t("story.chapter.aRollPlaceholder")}
            onCommit={(aRoll) => set("aRoll", aRoll)}
          />
        </Field>
        {ranges.length === 0 ? (
          <p className="text-sm leading-[17px] text-fg-3">{t("story.chapter.noARoll")}</p>
        ) : (
          <ol className="grid gap-1.5" aria-label={t("story.chapter.sourceRanges")}>
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
        <Button
          size="sm"
          variant="ghost"
          className="-ml-1 justify-self-start text-fg-3"
          icon={<Plus size={12} aria-hidden />}
          disabled={readOnly || (sources.length === 0 && ranges.length === 0)}
          onClick={addRange}
        >
          {t("story.chapter.addARoll")}
        </Button>
      </Section>

      <Section title={t("story.field.bRoll")}>
        <Field label={t("story.chapter.intent")} edited={edited.has("bRoll")}>
          <Input
            aria-label={t("story.chapter.bRollIntent")}
            value={chapter.bRoll}
            disabled={readOnly}
            onCommit={(bRoll) => set("bRoll", bRoll)}
          />
        </Field>
        <AttachedSlots
          graph={graph}
          chapterId={chapter.id}
          kinds={["video", "picture", "missing"]}
          readOnly={readOnly}
          onSelect={onSelect}
          onDetach={detach}
        />
      </Section>

      <Section title={t("story.chapter.section.motionCaptions")}>
        <Field label={t("story.chapter.intent")} edited={edited.has("graphics")}>
          <Input
            aria-label={t("story.chapter.graphicsIntent")}
            value={chapter.graphics}
            disabled={readOnly}
            onCommit={(graphics) => set("graphics", graphics)}
          />
        </Field>
        <AttachedSlots
          graph={graph}
          chapterId={chapter.id}
          kinds={["motion"]}
          readOnly={readOnly}
          onSelect={onSelect}
          onDetach={detach}
        />
        <Field label={t("story.field.captions")} edited={edited.has("captions")}>
          <Select
            label={t("story.field.captions")}
            value={chapter.captions ? "on" : "off"}
            disabled={readOnly}
            options={[
              { value: "off", label: t("story.chapter.captionsOff") },
              { value: "on", label: t("story.chapter.captionsOn") },
            ]}
            onCommit={(value) => set("captions", value === "on")}
          />
        </Field>
      </Section>

      <Section title={t("story.chapter.section.audio")}>
        <Field label={t("story.chapter.intent")} edited={edited.has("audio")}>
          <Input
            aria-label={t("story.chapter.audioIntent")}
            value={chapter.audio}
            disabled={readOnly}
            onCommit={(audio) => set("audio", audio)}
          />
        </Field>
        <AttachedSlots
          graph={graph}
          chapterId={chapter.id}
          kinds={["music"]}
          readOnly={readOnly}
          onSelect={onSelect}
          onDetach={detach}
        />
      </Section>

      <Section title={t("story.field.narration")}>
        <Field
          label={t("story.field.narration")}
          edited={edited.has("narration")}
          hint={t("story.chapter.narrationHint")}
          top
        >
          <TextAreaField
            label={t("story.field.narration")}
            value={chapter.narration}
            rows={4}
            disabled={readOnly}
            placeholder={t("story.chapter.narrationPlaceholder")}
            onCommit={(narration) => set("narration", narration)}
          />
        </Field>
      </Section>

      <Section title={t("story.chapter.section.timing")}>
        <Field
          label={t("story.field.duration")}
          edited={edited.has("estimatedDuration")}
          hint={
            material !== undefined && material !== null
              ? t("story.chapter.durationHintRoll", {
                  total: formatDuration(place.total),
                  roll: formatDuration(material),
                })
              : t("story.chapter.durationHint", { total: formatDuration(place.total) })
          }
        >
          <TimeField
            label={t("story.chapter.estimatedDuration")}
            value={chapter.estimatedDuration}
            disabled={readOnly}
            onCommit={(seconds) => seconds !== null && set("estimatedDuration", seconds)}
          />
        </Field>
        <Field label={t("story.chapter.transitionIn")}>
          {incoming ? (
            <Input
              aria-label={t("story.chapter.transitionIn")}
              value={incoming.transition}
              disabled={readOnly}
              placeholder={t("story.chapter.transitionPlaceholder")}
              onCommit={(transition) => onEdge({ ...incoming, transition })}
            />
          ) : (
            <span className="text-sm leading-6 text-fg-3">
              {place.index === 0 ? t("story.chapter.opens") : t("story.chapter.notLinked")}
            </span>
          )}
        </Field>
        <Field label={t("story.timeline.title")}>
          <span className="px-0.5 font-mono text-sm text-fg">
            {formatDuration(place.start)} – {formatDuration(end)}
          </span>
        </Field>
      </Section>

      <ChapterTimelineSection
        chapter={chapter.id}
        report={sync}
        facts={facts}
        readOnly={readOnly}
        onRebuild={onRebuild}
      />

      <Section title={t("story.chapter.section.lock")}>
        <ToggleRow
          label={t("story.inspector.locked")}
          checked={chapter.locked}
          disabled={readOnly}
          onCommit={(locked) => set("locked", locked)}
        />
        <HintNote icon={chapter.locked ? LockSimple : LockSimpleOpen}>
          {chapter.locked ? t("story.chapter.lockedOn") : t("story.chapter.lockedOff")}
        </HintNote>
      </Section>
    </>
  );
}
