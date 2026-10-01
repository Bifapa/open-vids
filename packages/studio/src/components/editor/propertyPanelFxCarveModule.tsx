/**
 * The voiceover carve, as one module in the FX rack.
 *
 * Carve is deliberately not an entry in the chain. It is a relationship between
 * two tracks — it analyses a voice and dips *this* bed where that voice sits —
 * so it gets its own card with a source picker, the way a sidechain control
 * lives on the track being processed. What it produces is an ordinary chain of
 * peaking filters, so it composes with whatever else is on the track.
 */

import {
  defaultAudioFxParams,
  getAudioFxDef,
  type HfAudioFxNode,
  type HfAudioFxParam,
} from "@hyperframes/core/audio-fx";
import { DEFAULT_CARVE, type HfCarveSettings } from "@hyperframes/core/audio-carve";
import { fxAutomationTarget } from "@hyperframes/core/audio-automation";
import { FxParamRow } from "./propertyPanelFxControls.js";
import { fxFamilyTint } from "./propertyPanelFxFamily.js";
import { ChartLine } from "@phosphor-icons/react";
import {
  INSP_CARD,
  INSP_FOCUS_INSET,
  INSP_FX_LABEL,
  INSP_MINI_LABEL,
  inspSwitchKnob,
  inspSwitchTrack,
} from "./inspectorStyles";
import { fxTintWash } from "./propertyPanelFxPresetStyle.js";
// Shared with the timeline's lane labels: a band is named by its frequency in
// both places, and two formatters would drift.
import { formatHz } from "../../player/components/automationLaneData";
import { formatNumber, t as translate, useTranslation } from "../../i18n";

export interface AudioTrackOption {
  id: string;
  label: string;
}

/** What one effect inside the module is called: its own name, plus the band. */
function carveMemberName(node: HfAudioFxNode): string {
  const def = getAudioFxDef(node.type);
  const freq = node.params?.["frequency"];
  const label = def?.label ?? node.type;
  return typeof freq === "number" ? `${label} ${formatHz(freq)}` : label;
}

/** A parameter's value as the rack shows it: rounded to the step, with its unit. */
function formatParamValue(param: HfAudioFxParam, raw: number | string | undefined): string {
  if (param.kind !== "number" || typeof raw !== "number") return String(raw ?? "");
  const places = param.step >= 1 ? 0 : param.step >= 0.1 ? 1 : 2;
  return `${formatNumber(raw, { maximumFractionDigits: places })}${param.unit ? ` ${param.unit}` : ""}`;
}

/**
 * Width to reserve for a parameter's value, in characters.
 *
 * Derived from what the parameter CAN read rather than what it currently reads, so
 * the column never moves: an automated value updates 30 times a second, and
 * `-1 dB` is two characters narrower than `-3.2 dB`, which was enough to shunt
 * everything after it sideways on every frame. `ch` is exact here because the
 * readouts are monospace and already `tabular-nums`.
 */
function paramValueWidthCh(param: HfAudioFxParam): number {
  if (param.kind === "enum") {
    return Math.max(1, ...param.options.map((option) => option.value.length));
  }
  const places = param.step >= 1 ? 0 : param.step >= 0.1 ? 1 : 2;
  const digits = Math.max(
    String(Math.floor(Math.abs(param.min))).length,
    String(Math.floor(Math.abs(param.max))).length,
  );
  const sign = param.min < 0 ? 1 : 0;
  const decimals = places > 0 ? places + 1 : 0;
  const unit = param.unit ? param.unit.length + 1 : 0;
  return sign + digits + decimals + unit;
}

/** One member of the module: what it is, and what every knob is set to. */
function FxCarveMember({
  node,
  automatedTargets,
  liveAutomationValues,
}: {
  node: HfAudioFxNode;
  automatedTargets?: ReadonlySet<string>;
  liveAutomationValues?: ReadonlyMap<string, number>;
}) {
  const { t } = useTranslation();
  const def = getAudioFxDef(node.type);
  if (!def) return null;
  const params = node.params ?? defaultAudioFxParams(node.type);
  return (
    <div className="hf-fx-carve-member flex flex-col gap-0.5 px-2 py-1.5">
      <span className="hf-fx-carve-member-name truncate text-xs font-medium text-fg-2">
        {carveMemberName(node)}
      </span>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {def.params.map((param) => {
          const target = node.id ? fxAutomationTarget(node.id, param.key) : null;
          const automated = Boolean(target && automatedTargets?.has(target));
          // The envelope's value at the playhead when there is one, which is what
          // the audio is using; the stored number is only the seed behind it.
          const live = target ? liveAutomationValues?.get(target) : undefined;
          const driven = automated && live !== undefined;
          const value = formatParamValue(param, driven ? live : params[param.key]);
          return (
            <span
              key={param.key}
              className="flex items-baseline gap-1 font-mono text-2xs text-fg-3"
              {...(automated ? { "data-automated": "" } : {})}
              {...(driven ? { "data-automation-live": "" } : {})}
            >
              <span className="font-ui text-fg-3">{param.label}</span>
              <span
                className="tabular-nums text-fg"
                style={{ minWidth: `${paramValueWidthCh(param)}ch` }}
              >
                {value}
              </span>
              {/* The lane is where an automated value comes from, and where it is
                  edited — saying so is the difference between a stale readout and
                  a pointer to the thing that owns it. */}
              {automated ? (
                <ChartLine
                  size={10}
                  aria-label={t("inspector.carve.automated")}
                  className="self-center text-fg"
                />
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The carve, as one module in the rack.
 *
 * A carve is one thing the author switched on; the peaking filters and the level
 * stage are how it is built. Listed individually they read as hand-built effects —
 * removable one at a time, reorderable, each with knobs the next strength change
 * silently overwrites. So the rack shows the unit, and the unit owns everything
 * that means anything for it: which voice it listens to, how hard it works,
 * whether it follows that voice, and what the analysis made of it.
 *
 * The controls used to sit in their own block under the rack, which read as a
 * second, unrelated feature that happened to produce effects somewhere else. One
 * card, controls above the analysis they drive, is the same thing said once.
 *
 * Grouped is not hidden. Opening it lists every effect inside with all of its
 * settings, because an author has to be able to see where the analysis landed — as
 * readouts rather than controls, since strength is what sets them and a knob here
 * would be overwritten by the next adjustment.
 */
export function FxCarveModule({
  nodes,
  carve,
  sourceOptions,
  automatedTargets,
  liveAutomationValues,
  open,
  disabled,
  analysing,
  onToggleOpen,
  onCarveChange,
  onCarvePreview,
}: {
  nodes: HfAudioFxNode[];
  carve: HfCarveSettings;
  sourceOptions: AudioTrackOption[];
  automatedTargets?: ReadonlySet<string>;
  liveAutomationValues?: ReadonlyMap<string, number>;
  open: boolean;
  disabled?: boolean;
  analysing?: boolean;
  onToggleOpen(): void;
  onCarveChange(carve: HfCarveSettings): void;
  onCarvePreview(carve: HfCarveSettings): void;
}) {
  const { t } = useTranslation();
  const on = carve.enabled;
  const soleVoice = soleCarveVoice(sourceOptions, carve.sources);
  const summary = carveSummary({ nodes, carve, analysing });
  // The carve's own colour, used three ways: the module's left edge, the title,
  // and the wash behind it. A preset gets a title treatment because it is a
  // character; the carve gets one because it is the only module in the rack
  // that LISTENS to another track, and a plain row understates that. It stays
  // in the smart family's monospace — what it shows is a readout, and a
  // display face would promise settings the author chose.
  const tint = fxFamilyTint({ type: "carve", fromCarve: true });
  const wash = fxTintWash(tint);
  return (
    <div
      className={`hf-fx-node hf-fx-carve-module hf-fx-carve ${INSP_CARD} border-l-2`}
      data-fx-node="carve"
      data-fx-family="smart"
      // Smart, like the Tone EQ and the leveller: it measures the audio and
      // writes its own settings, and what it shows is a readout of what it
      // decided rather than controls the author set.
      style={{ borderLeftColor: tint, ...(wash ? { backgroundColor: wash } : {}) }}
      data-carve-enabled={on ? "" : undefined}
    >
      <div className="hf-fx-node-head flex min-h-9 items-center gap-1 py-0.5 pl-1.5 pr-1">
        <span className="grid min-w-0 flex-1 gap-px rounded-xs px-1 py-[3px] transition-colors hover:bg-surface-2">
          <button
            type="button"
            className={`hf-fx-node-name min-w-0 truncate rounded-xs text-left text-sm font-medium leading-[15px] ${
              on ? "text-fg" : "text-fg-3"
            } ${INSP_FOCUS_INSET}`}
            // Truncates in a narrow panel like every other name in the rack.
            title={t("inspector.carve.title")}
            aria-expanded={open}
            onClick={onToggleOpen}
          >
            {t("inspector.carve.title")}
          </button>
          <span className="hf-fx-carve-summary truncate text-xs text-fg-3">{summary}</span>
        </span>
        {/* One switch, not a bypass and a delete. Off drops the effects and the
            envelopes it wrote, and is remembered — otherwise the default would
            re-apply the carve the next time this clip was selected. */}
        <button
          type="button"
          className={`hf-fx-bypass hf-fx-carve-toggle mx-0.5 ${inspSwitchTrack(on)}`}
          aria-pressed={on}
          aria-label={on ? t("inspector.carve.switchOff") : t("inspector.carve.switchOn")}
          title={on ? t("inspector.carve.switchOff") : t("inspector.carve.switchOn")}
          disabled={disabled}
          onClick={() => onCarveChange({ ...carve, enabled: !on })}
        >
          <span className={inspSwitchKnob(on)} />
        </button>
      </div>
      {open && on ? (
        <div className="hf-fx-carve-body border-t border-border-subtle">
          <div className="hf-fx-carve-controls grid gap-1.5 p-2">
            <CarveSourceRow
              carve={carve}
              sourceOptions={sourceOptions}
              soleVoice={soleVoice}
              disabled={disabled}
              onCarveChange={onCarveChange}
            />
            {/* One knob for the whole effect. Depth, band count, width, the
                intelligibility weighting and both level-match numbers move together
                anyway — a gentle carve is shallow in few bands with little ducking, a
                hard one is deeper in more with more — so the panel sets the strength
                and `carveProfile` derives the six numbers the analysis works in. */}
            <FxParamRow
              param={{
                kind: "number",
                key: "strength",
                label: t("inspector.carve.strength"),
                unit: "",
                min: 0,
                max: 1,
                step: 0.05,
                default: DEFAULT_CARVE.strength,
                hint: t("inspector.carve.strengthHint"),
              }}
              value={carve.strength}
              disabled={disabled || carve.sources.length === 0}
              onChange={(_k, v) => onCarvePreview({ ...carve, strength: Number(v) })}
              onCommit={(_k, v) => onCarveChange({ ...carve, strength: Number(v) })}
            />
          </div>
          {/* What the analysis made of all that. Divided rather than boxed: these
              are parts of one module, and a border around each would read as the
              separate effects this replaced. */}
          {/* While the analysis runs, the previous filters are gone rather than
              stale. Every number in that list is about to be replaced — a strength
              change re-derives all of them — so leaving them up reads as the
              settings that are in force when they are already history, and the one
              honest thing to say is that the work is happening. */}
          <CarveAnalysis
            nodes={nodes}
            analysing={analysing}
            hasSources={carve.sources.length > 0}
            automatedTargets={automatedTargets}
            liveAutomationValues={liveAutomationValues}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The only track this bed could be listening to, when there is exactly one.
 *
 * A picker with one entry is a question with one answer: it asks the author to
 * confirm something already decided. So the voice reads out instead.
 *
 * Not when the stored source is some OTHER track, though — a name that no longer
 * classifies as a voice, or a track since renamed. Reading out the one remaining
 * candidate there would quietly claim the carve listens to something it does not,
 * so the picker comes back and shows the mismatch.
 */
function soleCarveVoice(
  sourceOptions: AudioTrackOption[],
  sources: readonly string[],
): AudioTrackOption | null {
  if (sourceOptions.length !== 1) return null;
  const only = sourceOptions[0];
  if (!only) return null;
  if (sources.length === 0) return only;
  return sources.length === 1 && sources[0] === only.id ? only : null;
}

/**
 * What the module is worth right now, for its head, so a collapsed card still
 * says whether it is doing anything: the analysis it produced, or why not.
 */
function carveSummary(input: {
  nodes: HfAudioFxNode[];
  carve: HfCarveSettings;
  analysing?: boolean;
}): string {
  const { nodes, carve, analysing } = input;
  if (!carve.enabled) return translate("inspector.carve.summary.off");
  if (analysing) return translate("inspector.carve.summary.analysing");
  const bands = nodes.filter((n) => n.type === "peaking").length;
  if (bands === 0) {
    return carve.sources.length > 0
      ? translate("inspector.carve.summary.noAnalysis")
      : translate("inspector.carve.summary.pickVoice");
  }
  return translate("inspector.carve.summary.analysed", {
    bands,
    level: nodes.some((n) => n.type === "gain") ? "yes" : "no",
    // Worth saying when it is more than one: the cuts follow whoever is
    // speaking, and that is not obvious from a band count.
    voices: carve.sources.length > 1 ? carve.sources.length : 0,
  });
}

/** Which voices the bed makes room for: a readout when there is only one to
 *  choose, otherwise a set of checkboxes. */
function CarveSourceRow({
  carve,
  sourceOptions,
  soleVoice,
  disabled,
  onCarveChange,
}: {
  carve: HfCarveSettings;
  sourceOptions: AudioTrackOption[];
  soleVoice: AudioTrackOption | null;
  disabled?: boolean;
  onCarveChange(carve: HfCarveSettings): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="hf-fx-row flex min-h-6 items-center gap-1.5">
      {/* Wraps like every other name in this column (see FxParamRow) — one
          truncating row beside wrapping ones reads as a rendering bug. */}
      <span className={`hf-fx-label ${INSP_FX_LABEL}`}>{t("inspector.carve.listenTo")}</span>
      {soleVoice ? (
        <span
          className="hf-fx-carve-source min-w-0 flex-1 truncate font-mono text-num text-fg-2"
          data-carve-source={soleVoice.id}
        >
          {soleVoice.label}
        </span>
      ) : (
        /* Every voice, not one of them. A bed usually runs under a whole
           sequence — a narrator, an answer, a second presenter — and they are
           analysed together, so the cuts follow whoever is speaking. Which
           makes this a set of things to include, not a choice between them. */
        <div className="hf-fx-carve-sources grid min-w-0 flex-1 gap-0.5">
          {sourceOptions.map((o) => (
            <label
              key={o.id}
              className="flex h-6 min-w-0 items-center gap-1.5 rounded-xs px-1 text-sm text-fg transition-colors hover:bg-surface-2"
              title={t("inspector.carve.makeRoomFor", { label: o.label })}
            >
              <input
                type="checkbox"
                className="hf-fx-carve-source size-3.5 shrink-0 accent-fg"
                data-carve-source={o.id}
                checked={carve.sources.includes(o.id)}
                disabled={disabled}
                onChange={(e) =>
                  onCarveChange({
                    ...carve,
                    sources: e.target.checked
                      ? [...carve.sources, o.id]
                      : carve.sources.filter((id) => id !== o.id),
                  })
                }
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What the analysis made of all that. Divided rather than boxed: these are parts
 * of one module, and a border around each would read as the separate effects
 * this replaced.
 *
 * While the analysis runs the previous filters are gone rather than stale. Every
 * number in that list is about to be replaced — a strength change re-derives all
 * of them — so leaving them up reads as the settings that are in force when they
 * are already history, and the one honest thing to say is that the work is
 * happening.
 */
function CarveAnalysis({
  nodes,
  analysing,
  hasSources,
  automatedTargets,
  liveAutomationValues,
}: {
  nodes: HfAudioFxNode[];
  analysing?: boolean;
  hasSources: boolean;
  automatedTargets?: ReadonlySet<string>;
  liveAutomationValues?: ReadonlyMap<string, number>;
}) {
  const { t } = useTranslation();
  if (analysing) {
    return (
      <p className="hf-fx-carve-working flex items-center justify-center gap-1.5 border-t border-border-subtle py-2 text-xs text-fg-3">
        <svg
          className="hf-fx-carve-spinner h-3 w-3 animate-spin motion-reduce:animate-none"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        {t("inspector.carve.analysing")}
      </p>
    );
  }
  if (nodes.length === 0) {
    return (
      <p className="hf-fx-carve-working border-t border-border-subtle py-1.5 text-center text-xs text-fg-3">
        {hasSources ? t("inspector.carve.nothingAnalysed") : t("inspector.carve.pickVoices")}
      </p>
    );
  }
  return (
    <div className="hf-fx-carve-members divide-y divide-border-subtle border-t border-border-subtle">
      <div className={`hf-fx-carve-members-label px-2 pt-1.5 ${INSP_MINI_LABEL}`}>
        {t("inspector.carve.analysed")}
      </div>
      {nodes.map((node, i) => (
        <FxCarveMember
          key={node.id ?? `${node.type}-${i}`}
          node={node}
          automatedTargets={automatedTargets}
          liveAutomationValues={liveAutomationValues}
        />
      ))}
    </div>
  );
}
