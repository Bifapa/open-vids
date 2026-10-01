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
import { FIELD_LABELS, MISSING_KIND_LABELS, STORY_KIND_STYLES, materialRole } from "./storyKinds";
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
              aria-label={`Input ${index + 1} name`}
              value={key}
              disabled={disabled}
              onCommit={(name) => replace(index, name.trim(), value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              aria-label={`Input ${key}`}
              value={value}
              disabled={disabled}
              onCommit={(next) => replace(index, key, next)}
            />
          </div>
          <IconButton
            aria-label={`Remove input ${key}`}
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
        Input
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
  const edited = new Set(node.userEdited);
  switch (node.kind) {
    case "video":
      return (
        <>
          <Field label="Video" edited={edited.has("asset")}>
            <Select
              label="Video file"
              value={node.asset}
              options={assetOptions(library, "video", node.asset)}
              disabled={readOnly}
              onCommit={(asset) => onChange({ ...node, asset, previewFrame: null })}
            />
          </Field>
          <Field label="In" edited={edited.has("sourceIn")}>
            <TimeField
              label="Source in"
              value={node.sourceIn}
              precise
              disabled={readOnly}
              validate={(time) => node.sourceOut === null || time < node.sourceOut}
              onCommit={(time) => time !== null && onChange({ ...node, sourceIn: time })}
            />
          </Field>
          <Field label="Out" edited={edited.has("sourceOut")}>
            <TimeField
              label="Source out"
              value={node.sourceOut}
              precise
              optional
              placeholder="End"
              disabled={readOnly}
              validate={(time) => time > node.sourceIn}
              onCommit={(time) => onChange({ ...node, sourceOut: time })}
            />
          </Field>
        </>
      );
    case "picture":
      return (
        <Field label="Picture" edited={edited.has("asset")}>
          <Select
            label="Picture file"
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
          <Field label="Track" edited={edited.has("asset")}>
            <Select
              label="Music file"
              value={node.asset ?? NO_TRACK}
              options={[
                { value: NO_TRACK, label: "Not chosen yet" },
                ...assetOptions(library, "audio", node.asset),
              ]}
              disabled={readOnly}
              onCommit={(asset) => onChange({ ...node, asset: asset === NO_TRACK ? null : asset })}
            />
          </Field>
          <Field label="Volume" edited={edited.has("volume")}>
            <NumberField
              label="Volume"
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
              aria-label="Tempo"
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
          <Field label="Preset" edited={edited.has("preset")}>
            <Select
              label="Motion preset"
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
            label="Duration"
            edited={edited.has("duration")}
            hint="Empty: the preset’s own length."
          >
            <TimeField
              label="Motion duration"
              value={node.duration}
              optional
              disabled={readOnly}
              validate={(seconds) => seconds > 0}
              onCommit={(duration) => onChange({ ...node, duration })}
            />
          </Field>
          <Field label="Inputs" edited={edited.has("inputs")} top>
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
          <Field label="Needed media" edited={edited.has("mediaKind")}>
            <Select
              label="Needed media"
              value={node.mediaKind}
              options={MISSING_MEDIA_KINDS.map((kind) => ({
                value: kind,
                label: MISSING_KIND_LABELS[kind],
              }))}
              disabled={readOnly}
              onCommit={(value) => {
                const mediaKind = MISSING_MEDIA_KINDS.find((kind) => kind === value);
                if (mediaKind) onChange({ ...node, mediaKind });
              }}
            />
          </Field>
          <Field label="Needed" edited={edited.has("need")} top>
            <TextAreaField
              label="What is needed"
              value={node.need}
              disabled={readOnly}
              placeholder="Close-up of the keyboard, shallow depth of field"
              onCommit={(need) => onChange({ ...node, need })}
            />
          </Field>
          <Field label="Length" edited={edited.has("neededDuration")}>
            <TimeField
              label="Needed length"
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
        sub={`${style.label} · ${materialRole(node)}`}
      />
      <Section title={node.kind === "motion" ? "Use in chapter" : "Used in"}>
        <UsedInSlots
          graph={graph}
          order={order}
          nodeId={node.id}
          readOnly={readOnly}
          onSelect={onSelect}
          onDetach={(attachment) => onRemove([attachment])}
        />
      </Section>
      <Section title={node.kind === "missing" ? "Needed" : "Properties"}>
        <EditedChips fields={node.userEdited} labels={FIELD_LABELS} />
        <Field label="Title" edited={edited.has("title")}>
          <Input
            aria-label="Title"
            value={node.title}
            disabled={readOnly}
            onCommit={(title) => title.trim() && onChange({ ...node, title: title.trim() })}
          />
        </Field>
        <KindFields node={node} library={props.library} readOnly={readOnly} onChange={onChange} />
        {node.kind !== "missing" && (
          <Field label="Usage" edited={edited.has("usageIntent")} top>
            <TextAreaField
              label="Usage intent"
              value={node.usageIntent}
              disabled={readOnly}
              rows={2}
              placeholder="How the material is used"
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
      <Section title="Lock">
        <ToggleRow
          label="Locked"
          checked={node.locked}
          disabled={readOnly}
          onCommit={(locked) => onChange({ ...node, locked })}
        />
        <HintNote icon={node.locked ? LockSimple : LockSimpleOpen}>
          {node.locked
            ? "The agent will not change it, or attach and detach it."
            : "Lock it to keep the agent from changing, attaching or detaching it."}
        </HintNote>
      </Section>
    </>
  );
}
