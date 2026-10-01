/**
 * One preset's bracket in the rack: its own header, on/off switch, amount lane
 * and the rows it wraps — or, for a run with no preset, just the rows.
 *
 * Split out of `propertyPanelFxSection.tsx`, whose `runs.map()` callback this
 * body used to be — one card per run, hand-built nodes included as runs with no
 * preset attached.
 */

import type {
  HfAudioFxNode,
  HfAudioFxParam,
  HfAudioFxParamValues,
} from "@hyperframes/core/audio-fx";
import { getAudioFxPreset } from "@hyperframes/core/audio-fx-presets";
import { FxParamRow } from "./propertyPanelFxControls.js";
import { fxPresetBackground, fxPresetStyle } from "./propertyPanelFxPresetStyle.js";
import { FxNodeRow } from "./propertyPanelFxNodeRow.js";
import { CaretDown, X } from "@phosphor-icons/react";
import { INSP_MINI_BUTTON, inspSwitchKnob, inspSwitchTrack } from "./inspectorStyles";

/**
 * The one control over a whole preset: how much of it is applied.
 *
 * Not in the effect registry — a preset is not an effect — so the row is
 * fabricated the same way the derived one-knob control is, and rendered by the
 * ordinary controls.
 */
const PRESET_AMOUNT_PARAM: HfAudioFxParam = {
  kind: "number",
  key: "amount",
  label: "Amount",
  unit: "",
  min: 0,
  max: 1,
  step: 0.01,
  default: 1,
  hint: "How much of this preset is applied. Automate it to bring the whole preset in or out over time.",
};

export interface FxPresetRunProps {
  run: { preset?: string; items: { node: HfAudioFxNode; i: number }[] };
  /** The number each row wears, counted over the whole rack. */
  positions: ReadonlyMap<number, number>;
  /** So the last row in the WHOLE chain knows it cannot move further down. */
  totalNodes: number;
  automatedTargets?: ReadonlySet<string>;
  liveAutomationValues?: ReadonlyMap<string, number>;
  onAutomateParam?(nodeId: string, paramKey: string): void;
  onRemoveParamAutomation?(nodeId: string, paramKey: string): void;
  openNode: number | null;
  onToggleOpenNode(index: number): void;
  disabled?: boolean;
  onUpdateNode(index: number, patch: Partial<HfAudioFxNode>): void;
  onMoveNode(index: number, delta: number): void;
  onRemoveNode(index: number): void;
  onPreviewNode(index: number, params: HfAudioFxParamValues): void;
  /** Whether this run's card is folded shut. Meaningless when there is no preset. */
  collapsed: boolean;
  onToggleCollapse(): void;
  /** How much of the preset is applied, 0..1 — the switch and the lane read the same value. */
  amount: number;
  onSetAmount(amount: number, persist?: boolean): void;
  onRemoveRun(): void;
  automated: boolean;
  onAutomate?(): void;
  onRemoveAutomation?(): void;
}

/** One run: a preset's bracket around its nodes, or a bare hand-built node. */
export function FxPresetRun({
  run,
  positions,
  totalNodes,
  automatedTargets,
  liveAutomationValues,
  onAutomateParam,
  onRemoveParamAutomation,
  openNode,
  onToggleOpenNode,
  disabled,
  onUpdateNode,
  onMoveNode,
  onRemoveNode,
  onPreviewNode,
  collapsed,
  onToggleCollapse,
  amount,
  onSetAmount,
  onRemoveRun,
  automated,
  onAutomate,
  onRemoveAutomation,
}: FxPresetRunProps) {
  const rows = run.items.map(({ node, i }) => (
    <FxNodeRow
      // Keyed by id, as the carve module's list above already is. On
      // `${type}-${index}` two effects of the same type keep their keys through
      // a reorder, so React reuses each row where it stands — and the controls
      // hold real state (a half-typed number, an in-flight drag), which then
      // lands on whichever effect moved into that slot.
      key={node.id ?? `${node.type}-${i}`}
      node={node}
      index={i}
      position={positions.get(i)}
      automatedTargets={automatedTargets}
      liveAutomationValues={liveAutomationValues}
      onAutomateParam={onAutomateParam}
      onRemoveParamAutomation={onRemoveParamAutomation}
      open={openNode === i}
      last={i === totalNodes - 1}
      disabled={disabled}
      onToggleOpen={() => onToggleOpenNode(i)}
      onUpdate={onUpdateNode}
      onMove={onMoveNode}
      onRemove={onRemoveNode}
      onPreview={onPreviewNode}
    />
  ));

  const preset = run.preset ? getAudioFxPreset(run.preset) : null;
  if (!preset) return rows;

  // On unless every node in it is bypassed: one switched back on means the
  // preset is doing something, and the switch has to offer to stop it rather
  // than claiming it has already stopped.
  const runOn = amount > 0;
  const style = fxPresetStyle(run.preset ?? "");
  const background = fxPresetBackground(run.preset ?? "");

  return (
    <div
      className="hf-fx-preset-run grid gap-1 rounded-sm border border-l-2 border-dashed border-border p-1"
      data-fx-preset={run.preset}
      data-collapsed={collapsed ? "" : undefined}
      // The bracket's edge carries the preset's own colour, the way a module's
      // carries its family's — and the wash behind it is the same hue taken to
      // near-black, so a rack with three presets in it reads as three regions
      // rather than one long list.
      style={{
        borderLeftColor: style.color,
        ...(background ? { backgroundColor: background } : {}),
      }}
    >
      <div className="hf-fx-preset-run-head flex min-h-7 items-center gap-1 pl-1 pr-0.5">
        <button
          type="button"
          className={`hf-fx-preset-run-label min-w-0 flex-1 truncate text-left leading-tight hover:opacity-80 ${style.type}`}
          // The face and the colour are data, not classes: a Tailwind class
          // cannot name a font stack the config does not know, and adding eight
          // to the config to style one panel would put them in every
          // autocomplete in the studio.
          style={{
            color: style.color,
            ...(style.family ? { fontFamily: style.family } : {}),
          }}
          aria-expanded={!collapsed}
          title={
            collapsed ? `Show what ${preset.label} contains` : `Hide ${preset.label}'s effects`
          }
          onClick={onToggleCollapse}
        >
          <span className="hf-fx-preset-run-caret pr-1 text-fg-3" aria-hidden="true">
            <CaretDown
              size={12}
              className={`inline align-[-2px] transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
          </span>
          {preset.label}
          {/* Collapsed, the count is what says the preset is still a chain
              rather than one opaque effect. */}
          {collapsed ? (
            <span className="hf-fx-preset-run-count ml-1.5 rounded-pill bg-surface-3 px-[5px] font-ui text-2xs leading-[14px] tracking-normal text-fg">
              {run.items.length}
            </span>
          ) : null}
        </button>
        {/* The whole preset, on or off. Partly-bypassed reads as off, because
            "some of it is running" is not a state an author set — it is one
            they arrived at, and the switch is how they get back out of it. */}
        <button
          type="button"
          className={`hf-fx-preset-run-toggle mx-0.5 ${inspSwitchTrack(runOn)}`}
          aria-pressed={runOn}
          aria-label={runOn ? `Switch ${preset.label} off` : `Switch ${preset.label} back on`}
          title={runOn ? `Switch ${preset.label} off` : `Switch ${preset.label} back on`}
          disabled={disabled}
          onClick={() => onSetAmount(runOn ? 0 : 1)}
        >
          <span className={inspSwitchKnob(runOn)} />
        </button>
        <button
          type="button"
          className={`hf-fx-preset-run-remove ${INSP_MINI_BUTTON} hover:text-error`}
          title={`Remove ${preset.label}`}
          aria-label={`Remove ${preset.label}`}
          disabled={disabled}
          onClick={onRemoveRun}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {/* The same value the switch sets, so an author can put the preset half
          in — and the lane below ramps it continuously. */}
      <FxParamRow
        param={PRESET_AMOUNT_PARAM}
        value={amount}
        disabled={disabled || automated}
        automated={automated}
        onChange={(_k, v) => onSetAmount(Number(v), false)}
        onCommit={(_k, v) => onSetAmount(Number(v))}
        onAutomate={onAutomate}
        onRemoveAutomation={onRemoveAutomation}
      />
      {collapsed ? null : rows}
    </div>
  );
}
