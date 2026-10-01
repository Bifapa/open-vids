import { LockSimple, LockSimpleOpen, Plus, Trash } from "@phosphor-icons/react";
import {
  MISSING_MEDIA_KINDS,
  storyOrder,
  type AssetKind,
  type MotionNode,
  type StoryGraph,
  type StoryMaterialNode,
} from "@hyperframes/agent-protocol";
import {
  Button,
  IconButton,
  Input,
  NumberField,
  Select,
  type SelectOption,
} from "../components/ui";
import { useTranslation } from "../i18n";
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
import { fileName } from "./storyFormat";
import { MISSING_KIND_KEYS, STORY_KIND_STYLES, materialRoleKey } from "./storyKinds";
import { UsedInSlots } from "./StorySlots";
import type { StoryLibrary } from "./useStoryLibrary";
import { MissingResearchSection, ResolutionSection } from "./StoryProvenance";

export interface MaterialInspectorProps {
  node: StoryMaterialNode;
  graph: StoryGraph;
  library: StoryLibrary;
  readOnly: boolean;
  onChange: (next: StoryMaterialNode) => void;
  /** Deletes attachments (a "Used in" row's detach). */
  onRemove: (ids: string[]) => void;
  onSelect: (selection: StorySelection) => void;
}

const NO_TRACK = "__none__";

/** Project assets of `kind` as options, keeping the current value even when the file is gone. */
function assetOptions(
  library: StoryLibrary,
  kind: AssetKind,
  current: string | null,
): SelectOption[] {
  const paths = library.assets.filter((asset) => asset.kind === kind).map((asset) => asset.path);
  if (current && !paths.includes(current)) paths.unshift(current);
  return paths.map((path) => ({ value: path, label: fileName(path) }));
}

function InputsEditor({
  node,
  disabled,
  onChange,
}: {
  node: MotionNode;
  disabled: boolean;
  onChange: (inputs: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(node.inputs);
  const replace = (index: number, key: string, value: string) =>
    onChange(
      Object.fromEntries(
        entries.map((entry, at) => (at === index ? [key, value] : entry)).filter(([name]) => name),
      ),
    );
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([key, value], index) => (
        <div key={key} className="flex items-center gap-1">
          <div className="w-16 shrink-0">
            <Input
              aria-label={t("story.material.inputName", { number: index + 1 })}
              value={key}
              disabled={disabled}
              onCommit={(name) => replace(index, name.trim(), value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              aria-label={t("story.material.inputValue", { name: key })}
              value={value}
              disabled={disabled}
              onCommit={(next) => replace(index, key, next)}
            />
          </div>
          <IconButton
            aria-label={t("story.material.inputRemove", { name: key })}
            size="sm"
            disabled={disabled}
            icon={<Trash size={12} aria-hidden />}
            onClick={() => onChange(Object.fromEntries(entries.filter((_, at) => at !== index)))}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        disabled={disabled || "" in node.inputs}
        icon={<Plus size={12} aria-hidden />}
        onClick={() => {
          let name = "value";
          for (let count = 2; name in node.inputs; count += 1) name = `value${count}`;
          onChange({ ...node.inputs, [name]: "" });
        }}
      >
        {t("story.material.addInput")}
      </Button>
    </div>
  );
}

function KindFields({
  node,
  library,
  readOnly,
  onChange,
}: Omit<MaterialInspectorProps, "graph" | "onSelect" | "onRemove">) {
  const { t } = useTranslation();
  const edited = new Set(node.userEdited);
  switch (node.kind) {
    case "video":
      return (
        <>
          <Field label={t("story.material.video")} edited={edited.has("asset")}>
            <Select
              label={t("story.material.videoFile")}
              value={node.asset}
              options={assetOptions(library, "video", node.asset)}
              disabled={readOnly}
              onCommit={(asset) => onChange({ ...node, asset, previewFrame: null })}
            />
          </Field>
          <Field label={t("story.material.in")} edited={edited.has("sourceIn")}>
            <TimeField
              label={t("story.material.sourceIn")}
              value={node.sourceIn}
              precise
              disabled={readOnly}
              validate={(time) => node.sourceOut === null || time < node.sourceOut}
              onCommit={(time) => time !== null && onChange({ ...node, sourceIn: time })}
            />
          </Field>
          <Field label={t("story.material.out")} edited={edited.has("sourceOut")}>
            <TimeField
              label={t("story.material.sourceOut")}
              value={node.sourceOut}
              precise
              optional
              placeholder={t("story.material.outPlaceholder")}
              disabled={readOnly}
              validate={(time) => time > node.sourceIn}
              onCommit={(time) => onChange({ ...node, sourceOut: time })}
            />
          </Field>
        </>
      );
    case "picture":
      return (
        <Field label={t("story.material.picture")} edited={edited.has("asset")}>
          <Select
            label={t("story.material.pictureFile")}
            value={node.asset}
            options={assetOptions(library, "image", node.asset)}
            disabled={readOnly}
            onCommit={(asset) => onChange({ ...node, asset })}
          />
        </Field>
      );
    case "music":
      return (
        <>
          <Field label={t("story.material.track")} edited={edited.has("asset")}>
            <Select
              label={t("story.material.musicFile")}
              value={node.asset ?? NO_TRACK}
              options={[
                { value: NO_TRACK, label: t("story.material.notChosen") },
                ...assetOptions(library, "audio", node.asset),
              ]}
              disabled={readOnly}
              onCommit={(asset) => onChange({ ...node, asset: asset === NO_TRACK ? null : asset })}
            />
          </Field>
          <Field label={t("story.material.volume")} edited={edited.has("volume")}>
            <NumberField
              label={t("story.material.volume")}
              value={Math.round(node.volume * 100)}
              unit="%"
              min={0}
              max={100}
              step={5}
              disabled={readOnly}
              onCommit={(percent) =>
                onChange({ ...node, volume: Math.min(1, Math.max(0, percent / 100)) })
              }
            />
          </Field>
          <Field label="BPM" edited={edited.has("bpm")}>
            <Input
              aria-label={t("story.material.tempo")}
              value={node.bpm === null ? "" : String(node.bpm)}
              placeholder="–"
              disabled={readOnly}
              onCommit={(text) => {
                const bpm = text.trim() === "" ? null : Number(text);
                if (bpm === null || (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400)) {
                  onChange({ ...node, bpm });
                }
              }}
            />
          </Field>
        </>
      );
    case "motion": {
      const presets = library.presets.map((preset) => ({
        value: preset.name,
        label: preset.title || preset.name,
      }));
      if (!presets.some((option) => option.value === node.preset)) {
        presets.unshift({ value: node.preset, label: node.preset });
      }
      return (
        <>
          <Field label={t("story.material.preset")} edited={edited.has("preset")}>
            <Select
              label={t("story.material.motionPreset")}
              value={node.preset}
              options={presets}
              disabled={readOnly}
              onCommit={(preset) => {
                const info = library.presets.find((candidate) => candidate.name === preset);
                onChange({ ...node, preset, duration: node.duration ?? info?.duration ?? null });
              }}
            />
          </Field>
          <Field
            label={t("story.material.duration")}
            edited={edited.has("duration")}
            hint={t("story.material.durationHint")}
          >
            <TimeField
              label={t("story.material.motionDuration")}
              value={node.duration}
              optional
              disabled={readOnly}
              validate={(seconds) => seconds > 0}
              onCommit={(duration) => onChange({ ...node, duration })}
            />
          </Field>
          <Field label={t("story.material.inputs")} edited={edited.has("inputs")} top>
            <InputsEditor
              node={node}
              disabled={readOnly}
              onChange={(inputs) => onChange({ ...node, inputs })}
            />
          </Field>
        </>
      );
    }
    case "missing":
      return (
        <>
          <Field label={t("story.material.neededMedia")} edited={edited.has("mediaKind")}>
            <Select
              label={t("story.material.neededMedia")}
              value={node.mediaKind}
              options={MISSING_MEDIA_KINDS.map((kind) => ({
                value: kind,
                label: t(MISSING_KIND_KEYS[kind]),
              }))}
              disabled={readOnly}
              onCommit={(value) => {
                const mediaKind = MISSING_MEDIA_KINDS.find((kind) => kind === value);
                if (mediaKind) onChange({ ...node, mediaKind });
              }}
            />
          </Field>
          <Field label={t("story.material.needed")} edited={edited.has("need")} top>
            <TextAreaField
              label={t("story.material.whatNeeded")}
              value={node.need}
              disabled={readOnly}
              placeholder={t("story.material.needPlaceholder")}
              onCommit={(need) => onChange({ ...node, need })}
            />
          </Field>
          <Field label={t("story.material.length")} edited={edited.has("neededDuration")}>
            <TimeField
              label={t("story.material.neededLength")}
              value={node.neededDuration}
              optional
              disabled={readOnly}
              validate={(seconds) => seconds > 0}
              onCommit={(neededDuration) => onChange({ ...node, neededDuration })}
            />
          </Field>
        </>
      );
  }
}

export function MaterialInspector(props: MaterialInspectorProps) {
  const { t } = useTranslation();
  const { node, graph, readOnly, onChange, onSelect, onRemove } = props;
  const style = STORY_KIND_STYLES[node.kind];
  const edited = new Set(node.userEdited);
  const order = storyOrder(graph).chapters;
  return (
    <>
      <InspectorHead
        icon={style.icon}
        chip={style.chip}
        name={node.title}
        sub={t("story.material.subtitle", {
          kind: t(style.labelKey),
          role: t(materialRoleKey(node)),
        })}
      />
      <Section
        title={
          node.kind === "motion" ? t("story.material.useInChapter") : t("story.material.usedIn")
        }
      >
        <UsedInSlots
          graph={graph}
          order={order}
          nodeId={node.id}
          readOnly={readOnly}
          onSelect={onSelect}
          onDetach={(attachment) => onRemove([attachment])}
        />
      </Section>
      <Section
        title={
          node.kind === "missing" ? t("story.material.needed") : t("story.material.properties")
        }
      >
        <EditedChips fields={node.userEdited} />
        <Field label={t("story.field.title")} edited={edited.has("title")}>
          <Input
            aria-label={t("story.field.title")}
            value={node.title}
            disabled={readOnly}
            onCommit={(title) => title.trim() && onChange({ ...node, title: title.trim() })}
          />
        </Field>
        <KindFields node={node} library={props.library} readOnly={readOnly} onChange={onChange} />
        {node.kind !== "missing" && (
          <Field label={t("story.material.usage")} edited={edited.has("usageIntent")} top>
            <TextAreaField
              label={t("story.material.usageIntent")}
              value={node.usageIntent}
              disabled={readOnly}
              rows={2}
              placeholder={t("story.material.usagePlaceholder")}
              onCommit={(usageIntent) => onChange({ ...node, usageIntent })}
            />
          </Field>
        )}
      </Section>
      {node.kind === "missing" ? (
        <MissingResearchSection node={node} />
      ) : (
        <ResolutionSection node={node} />
      )}
      <Section title={t("story.chapter.section.lock")}>
        <ToggleRow
          label={t("story.inspector.locked")}
          checked={node.locked}
          disabled={readOnly}
          onCommit={(locked) => onChange({ ...node, locked })}
        />
        <HintNote icon={node.locked ? LockSimple : LockSimpleOpen}>
          {node.locked ? t("story.material.lockedOn") : t("story.material.lockedOff")}
        </HintNote>
      </Section>
    </>
  );
}
