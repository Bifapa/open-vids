import { createHash } from "node:crypto";
import {
  captionCuesFromWords,
  isChapter,
  type CaptionCue,
  type EditOperation,
  type EditOperationResult,
  type ManualEditPolicy,
  type PlacedRange,
  type StoryGraph,
  type StoryManualEdit,
  type StorySyncAction,
  type StorySyncChange,
  type StorySyncReport,
  type StorySyncRole,
  type StorySyncSection,
  type StorySyncUnit,
  type StoryUnrelatedClip,
  type TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { findCaptionsHost } from "../editing/captions.js";
import { aiEditTurn, clipState, clipStateChanges, type ClipState } from "../editing/clipState.js";
import { isUntouchedTemplatePlaceholder } from "../editing/placeholder.js";
import { clipLabel, readClipProvenance, type ClipNode } from "../editing/timeline.js";
import { pickedFragment } from "../helpers/pickedRange.js";
import { sameJson } from "./graphIo.js";
import {
  MUSIC_FADE_SECONDS,
  STORY_TRACKS,
  round3,
  type IntentSection,
  type IntentUnit,
  type StoryIntent,
} from "./compile.js";
import {
  SYNC_LEDGER_SCHEMA,
  type LedgerCaptions,
  type LedgerEntity,
  type LedgerSection,
  type LedgerUnit,
  type SyncLedger,
} from "./ledger.js";

const EPS = 0.0005;
/** Layout slack: clip starts and lengths are written to the millisecond, so sums drift by a few of them. */
const LAYOUT_EPS = 0.005;
const MAX_UNRELATED_REPORTED = 200;

/** The composition as the planner sees it: its parsed clips (durations resolved) and the captions file. */
export interface TimelineState {
  clips: ClipNode[];
  duration: number;
  /** Fingerprint of the captions file right now (null: there is none). */
  captionsFile: string | null;
}

export interface PlanInput {
  /** The composition the story builds into (recorded in the ledger). */
  composition: string;
  graph: StoryGraph;
  intent: StoryIntent;
  /** The sync record, or null when there is none (never built, or built before synchronization). */
  ledger: SyncLedger | null;
  timeline: TimelineState;
  /** Transcripts of the sources captions may read. */
  transcripts: ReadonlyMap<string, TranscriptArtifact | null>;
  /** `full`: Build Story (everything regenerated); `rebuild`: only what the graph changed. */
  mode: "full" | "rebuild";
  /** rebuild: only these chapters' changed sections are regenerated (null: all). */
  chapters: ReadonlySet<string> | null;
  manualEdits: ManualEditPolicy;
  allowLocked: ReadonlySet<string>;
  turnId: string | null;
  now: number;
}

export interface PlannedSection {
  chapter: string;
  start: number;
  end: number;
  /** Clips the section owns once the batch ran. */
  clips: number;
}

/** A material clip the batch creates (`operation`: its index in the batch). */
export interface PlannedMaterial {
  node: string;
  chapter: string;
  operation: number;
  start: number;
  end: number;
  track: number;
}

export interface SyncPlan {
  report: StorySyncReport;
  operations: EditOperation[];
  duration: number;
  /** Placed sections in play order, for the graph's build record. */
  sections: PlannedSection[];
  materials: PlannedMaterial[];
  rebuilt: string[];
  removed: string[];
  moved: string[];
  keptEdits: StoryManualEdit[];
  replacedEdits: StoryManualEdit[];
  keptLocked: string[];
  removedClips: number;
  keptClips: number;
  captions: { preset: string; cues: number } | null;
  /** The ledger after the operations ran: created clips' ids come from the results, their states from the new file. */
  finish(results: EditOperationResult[], after: TimelineState): SyncLedger;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function mode(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && Math.abs(value) < Math.abs(best))) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const isMoved = (delta: number) => Math.abs(delta) > LAYOUT_EPS;
const ref = (clip: ClipNode) => clip.id || clip.domId || "";
const basename = (path: string | null) => (path ? (path.split("/").pop() ?? path) : null);

function opsLength(ops: readonly EditOperation[]): number {
  let total = 0;
  for (const op of ops) {
    if (op.op === "add_sequence") for (const range of op.ranges) total += range.to - range.from;
  }
  return round3(total);
}

const OP_FIELD_WORDS: Record<string, string> = {
  asset: "file",
  name: "preset",
  start: "position in the chapter",
  duration: "length",
  mediaStart: "in-point",
  volume: "volume",
  muted: "sound",
  fit: "framing",
  fadeIn: "fades",
  fadeOut: "fades",
  track: "track",
};

/** Why a unit's intent differs from what was built, in words. */
function unitReasons(
  role: StorySyncRole,
  built: unknown,
  wanted: readonly EditOperation[],
): string[] {
  const before: unknown[] = Array.isArray(built) ? built : [];
  if (role === "a_roll") {
    const old = before.filter(isEditOperation);
    return [`A-roll changed: ${opsLength(old)} s → ${opsLength(wanted)} s`];
  }
  if (before.length === 0 && wanted.length > 0) return ["now placed"];
  if (before.length > 0 && wanted.length === 0) return ["no longer placed"];
  const a = before[0];
  const b = wanted[0];
  if (!isPlainRecord(a) || !b) return ["changed"];
  const words = new Set<string>();
  const bRecord: Record<string, unknown> = { ...b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(bRecord)])) {
    if (!sameJson(a[key], bRecord[key])) words.add(OP_FIELD_WORDS[key] ?? key);
  }
  return words.size > 0 ? [[...words].join(", ") + " changed"] : ["changed"];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditOperation(value: unknown): value is EditOperation {
  return isPlainRecord(value) && typeof value.op === "string";
}

/** `add_*` operations of a unit placed at `at` on the timeline, stamped with their story node and turn. */
function placeOps(unit: IntentUnit, at: number, turnId: string | null): EditOperation[] {
  const provenance = { storyNode: unit.node, ...(turnId !== null && { turn: turnId }) };
  return unit.ops.flatMap((op): EditOperation[] => {
    switch (op.op) {
      case "add_sequence":
        return [{ ...op, start: round3(at + (op.start ?? 0)), provenance }];
      case "add_clip":
      case "add_component":
      case "add_text":
        return [{ ...op, start: round3(at + op.start), provenance }];
      default:
        return [];
    }
  });
}

// ── working model ────────────────────────────────────────────────────────────

interface WorkUnit {
  node: string;
  role: StorySyncRole;
  title: string;
  ledger: LedgerUnit | null;
  intent: IntentUnit | null;
  change: StorySyncChange;
  reasons: string[];
  action: StorySyncAction;
  edits: StoryManualEdit[];
  /** Present clips it owns (ledger entities still on the timeline). */
  present: ClipNode[];
  /** Copies/splits of its clips (story provenance, unknown to the ledger). */
  derived: ClipNode[];
  /** Material node is locked. */
  nodeLocked: boolean;
}

interface WorkSection {
  chapter: string;
  title: string;
  intent: IntentSection | null;
  ledger: LedgerSection | null;
  /** Timeline shift of the whole section since the last sync. */
  shift: number;
  curStart: number;
  slot: number;
  units: WorkUnit[];
  change: StorySyncChange;
  reasons: string[];
  locked: boolean;
  /** On the new timeline (false: removed, or an added chapter outside the rebuild's scope). */
  placed: boolean;
  newStart: number;
  newLength: number;
  delta: number;
}

const TOUCHING: ReadonlySet<StorySyncAction> = new Set(["rebuild", "remove"]);

/**
 * Plans a Build Story (`full`) or a Rebuild (`rebuild`) against the sync ledger. Pure: it reads the graph's intent,
 * the ledger and the parsed timeline and returns one atomic batch plus the report of what it does.
 *
 * - Ownership comes from the ledger (section → unit → clip ids), never from comparing HTML. A generated clip whose
 *   structured state differs from its record (beyond its section's shift) is a manual edit; a missing one was
 *   removed; a clip with story provenance the ledger does not know is a copy/split. Every other clip is unrelated.
 * - Units whose intent is unchanged keep their clips byte-for-byte (they only move when their section moves).
 * - Sections are laid back to back in the graph's order from where the story starts; an unchanged section keeps
 *   its current extent (the user's trims and gaps included), a regenerated one takes its compiled length.
 * - Unrelated clips move with the section they sit in; before the story they stay, after it they follow its end.
 */
export function planSync(input: PlanInput): SyncPlan {
  const { graph, intent, ledger, timeline, mode: planMode } = input;
  const full = planMode === "full";
  const warnings = [...intent.warnings];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const byId = new Map<string, ClipNode>();
  for (const clip of timeline.clips) if (clip.id) byId.set(clip.id, clip);
  const states = new Map<ClipNode, ClipState>();
  const stateOf = (clip: ClipNode) => {
    let state = states.get(clip);
    if (!state) {
      state = clipState(clip);
      states.set(clip, state);
    }
    return state;
  };

  // ── ownership ────────────────────────────────────────────────────────────
  const owned = new Set<ClipNode>();
  const presentOf = (unit: LedgerUnit | null) =>
    (unit?.entities ?? []).flatMap((entity) => {
      const clip = byId.get(entity.clip);
      return clip ? [clip] : [];
    });
  for (const section of ledger?.sections ?? []) {
    for (const unit of section.units) for (const clip of presentOf(unit)) owned.add(clip);
  }
  for (const unit of ledger?.music ?? []) for (const clip of presentOf(unit)) owned.add(clip);
  const captionsHost = findCaptionsHost(timeline.clips, input.composition)?.host ?? null;

  const editsOf = (unit: LedgerUnit, shift: number, title: string): StoryManualEdit[] => {
    const edits: StoryManualEdit[] = [];
    for (const entity of unit.entities) {
      const clip = byId.get(entity.clip);
      if (!clip) {
        edits.push({
          clip: entity.clip,
          label: `${title} · ${basename(entity.state.src ?? entity.state.compositionSrc) ?? entity.state.kind}`,
          kind: "removed",
          by: "unknown",
          turn: null,
          fields: [],
        });
        continue;
      }
      const state = stateOf(clip);
      const fields = clipStateChanges(state, entity.state, shift);
      if (fields.length === 0) continue;
      const turn = aiEditTurn(clip, state);
      edits.push({
        clip: clip.id,
        label: `${title} · ${clipLabel(clip)}`,
        kind: "modified",
        by: turn ? "ai" : "user",
        turn,
        fields,
      });
    }
    return edits;
  };

  const sectionShift = (section: LedgerSection): number =>
    mode(
      section.units.flatMap((unit) =>
        unit.entities.flatMap((entity) => {
          const clip = byId.get(entity.clip);
          return clip ? [round3(stateOf(clip).start - entity.state.start)] : [];
        }),
      ),
    );

  // ── current sections ─────────────────────────────────────────────────────
  const intentById = new Map(intent.sections.map((section) => [section.chapter.id, section]));
  const current: WorkSection[] = (ledger?.sections ?? []).map((section) => {
    const shift = sectionShift(section);
    const curStart = round3(section.start + shift);
    const chapterNode = nodes.get(section.chapter);
    const aRoll = section.units.find((unit) => unit.role === "a_roll");
    const aEnds = presentOf(aRoll ?? null).map((clip) => clip.end);
    const length = aEnds.length > 0 ? Math.max(...aEnds) - curStart : section.length;
    return {
      chapter: section.chapter,
      title: chapterNode?.title ?? section.chapter,
      intent: intentById.get(section.chapter) ?? null,
      ledger: section,
      shift,
      curStart,
      slot: round3(Math.max(0, length)),
      units: [],
      change: "unchanged",
      reasons: [],
      locked: chapterNode !== undefined && isChapter(chapterNode) && chapterNode.locked,
      placed: true,
      newStart: 0,
      newLength: 0,
      delta: 0,
    };
  });
  const byCurrentStart = [...current].sort((a, b) => a.curStart - b.curStart);
  for (const [index, section] of byCurrentStart.entries()) {
    const next = byCurrentStart[index + 1];
    if (next) section.slot = round3(Math.max(0, next.curStart - section.curStart));
  }
  const origin = byCurrentStart[0]?.curStart ?? 0;
  const last = byCurrentStart.at(-1);
  const currentEnd = last ? round3(last.curStart + last.slot) : 0;
  const sectionAt = (time: number): WorkSection | null =>
    byCurrentStart.find(
      (section) => time >= section.curStart - EPS && time < section.curStart + section.slot - EPS,
    ) ?? null;

  // ── derived and unrelated clips ──────────────────────────────────────────
  const derivedByUnit = new Map<string, ClipNode[]>();
  const unrelated: ClipNode[] = [];
  const staleStory: ClipNode[] = [];
  const unitKey = (chapter: string, node: string) => `${chapter}\0${node}`;
  for (const clip of timeline.clips) {
    if (owned.has(clip) || clip === captionsHost) continue;
    const storyNode = readClipProvenance(clip.element)?.storyNode ?? null;
    if (storyNode === null) {
      unrelated.push(clip);
      continue;
    }
    if (!ledger) {
      staleStory.push(clip);
      continue;
    }
    const home = sectionAt(clip.start);
    const inSection = home?.ledger?.units.some((unit) => unit.node === storyNode) ? home : null;
    const music = ledger.music.find((unit) => unit.node === storyNode);
    const key = inSection
      ? unitKey(inSection.chapter, storyNode)
      : music
        ? `music\0${storyNode}`
        : null;
    if (key === null) {
      unrelated.push(clip);
      continue;
    }
    const list = derivedByUnit.get(key) ?? [];
    list.push(clip);
    derivedByUnit.set(key, list);
  }
  const derivedEdits = (key: string, unit: LedgerUnit, title: string): StoryManualEdit[] =>
    (derivedByUnit.get(key) ?? []).map((clip) => {
      const stamped = aiEditTurn(clip, stateOf(clip));
      const turn = readClipProvenance(clip.element)?.turn ?? null;
      const byAi = stamped ?? (turn !== null && turn !== unit.turnId ? turn : null);
      return {
        clip: clip.id,
        label: `${title} · ${clipLabel(clip)}`,
        kind: "added",
        by: byAi ? "ai" : "user",
        turn: byAi,
        fields: [],
      };
    });

  // ── units: intent vs ledger ──────────────────────────────────────────────
  const inScope = (chapter: string) => input.chapters === null || input.chapters.has(chapter);
  const materialLocked = (node: string) => nodes.get(node)?.locked === true;

  const workUnits = (section: WorkSection): WorkUnit[] => {
    const ledgerUnits = section.ledger?.units ?? [];
    const intentUnits = section.intent ? [section.intent.aRoll, ...section.intent.materials] : [];
    const keys = [
      ...new Set([
        ...intentUnits.map((unit) => unit.node),
        ...ledgerUnits.map((unit) => unit.node),
      ]),
    ];
    return keys.flatMap((node): WorkUnit[] => {
      const built = ledgerUnits.find((unit) => unit.node === node) ?? null;
      const wanted = intentUnits.find((unit) => unit.node === node) ?? null;
      const wantedOps = wanted?.ops ?? [];
      const builtOps: unknown[] = built && Array.isArray(built.intent) ? built.intent : [];
      if (builtOps.length === 0 && wantedOps.length === 0 && (built?.entities.length ?? 0) === 0) {
        return [];
      }
      const role = wanted?.role ?? built?.role ?? "b_roll";
      const title =
        role === "a_roll"
          ? `${section.title} A-roll`
          : (wanted?.title ?? nodes.get(node)?.title ?? node);
      let change: StorySyncChange;
      if (!built) change = "added";
      else if (!section.intent || wantedOps.length === 0)
        change = builtOps.length === 0 ? "unchanged" : "removed";
      else change = sameJson(built.intent, wantedOps) ? "unchanged" : "changed";
      const edits = built
        ? [
            ...editsOf(built, section.shift, title),
            ...derivedEdits(unitKey(section.chapter, node), built, title),
          ]
        : [];
      return [
        {
          node,
          role,
          title,
          ledger: built,
          intent: wanted,
          change,
          reasons:
            change === "changed"
              ? unitReasons(role, built?.intent, wantedOps)
              : change === "removed"
                ? [section.intent ? "no longer in the chapter" : "chapter removed"]
                : [],
          action: "keep",
          edits,
          present: presentOf(built),
          derived: derivedByUnit.get(unitKey(section.chapter, node)) ?? [],
          nodeLocked: role !== "a_roll" && materialLocked(node),
        },
      ];
    });
  };

  const sections: WorkSection[] = [];
  const removedSections: WorkSection[] = [];
  const currentById = new Map(current.map((section) => [section.chapter, section]));
  for (const wanted of intent.sections) {
    const existing = currentById.get(wanted.chapter.id);
    const section: WorkSection = existing ?? {
      chapter: wanted.chapter.id,
      title: wanted.chapter.title,
      intent: wanted,
      ledger: null,
      shift: 0,
      curStart: 0,
      slot: 0,
      units: [],
      change: "added",
      reasons: ["not built yet"],
      locked: wanted.chapter.locked,
      placed: true,
      newStart: 0,
      newLength: 0,
      delta: 0,
    };
    section.title = wanted.chapter.title;
    section.units = workUnits(section);
    if (existing) {
      const lengthChanged = Math.abs(wanted.length - (existing.ledger?.length ?? 0)) > EPS;
      const changedUnits = section.units.filter((unit) => unit.change !== "unchanged");
      if (changedUnits.length > 0 || lengthChanged) {
        section.change = "changed";
        section.reasons = changedUnits.flatMap((unit) =>
          unit.role === "a_roll"
            ? unit.reasons
            : unit.reasons.map((reason) => `${unit.title}: ${reason}`),
        );
        if (lengthChanged && !changedUnits.some((unit) => unit.role === "a_roll")) {
          section.reasons.push(`length ${existing.ledger?.length ?? 0} s → ${wanted.length} s`);
        }
      }
    }
    sections.push(section);
  }
  for (const section of current) {
    if (intentById.has(section.chapter)) continue;
    section.intent = null;
    section.units = workUnits(section);
    section.change = "removed";
    section.reasons = ["chapter removed from the story"];
    section.placed = false;
    removedSections.push(section);
  }

  // ── actions ──────────────────────────────────────────────────────────────
  const conflictsBefore = { count: 0 };
  const decide = (section: WorkSection, unit: WorkUnit): StorySyncAction => {
    const removedSection = section.change === "removed";
    const wantsTouch = full
      ? unit.ledger !== null || (unit.intent?.ops.length ?? 0) > 0
      : unit.change !== "unchanged";
    if (!wantsTouch) return "keep";
    const base: StorySyncAction = full
      ? (unit.intent?.ops.length ?? 0) > 0
        ? unit.ledger
          ? "rebuild"
          : "add"
        : "remove"
      : unit.change === "added"
        ? "add"
        : unit.change === "removed"
          ? "remove"
          : "rebuild";
    const frozen =
      !removedSection && section.ledger !== null && (section.locked || unit.nodeLocked);
    if (frozen && !input.allowLocked.has(section.chapter)) return "keep_locked";
    if (!full && !removedSection && section.ledger !== null && !inScope(section.chapter))
      return "skip";
    if (base === "add") return "add";
    const lockedOnTimeline = [...unit.present, ...unit.derived].some((clip) => clip.locked);
    if (unit.edits.length > 0) conflictsBefore.count += 1;
    if (lockedOnTimeline) return "keep_edited";
    if (unit.edits.length > 0 && !full && input.manualEdits === "keep") return "keep_edited";
    return base;
  };
  for (const section of [...sections, ...removedSections]) {
    if (section.ledger === null && !full && !inScope(section.chapter)) {
      section.placed = false;
      for (const unit of section.units) unit.action = "skip";
      continue;
    }
    for (const unit of section.units) unit.action = decide(section, unit);
  }

  // ── layout ───────────────────────────────────────────────────────────────
  let cursor = origin;
  for (const section of sections) {
    if (!section.placed) continue;
    const aRoll = section.units.find((unit) => unit.role === "a_roll");
    const regenerated = aRoll !== undefined && TOUCHING.has(aRoll.action);
    const added = aRoll?.action === "add";
    const silentResize =
      section.ledger !== null &&
      section.intent !== null &&
      (aRoll === undefined || aRoll.action === "keep") &&
      section.intent.aRoll.ops.length === 0 &&
      Math.abs(section.intent.length - section.ledger.length) > EPS &&
      !(section.locked && !input.allowLocked.has(section.chapter)) &&
      (full || inScope(section.chapter));
    const fresh = section.ledger === null || regenerated || added || silentResize;
    section.newLength = round3(fresh && section.intent ? section.intent.length : section.slot);
    section.newStart = round3(cursor);
    section.delta = section.ledger ? round3(section.newStart - section.curStart) : 0;
    cursor += section.newLength;
  }
  const newEnd = round3(cursor);
  const tailDelta = ledger ? round3(newEnd - currentEnd) : 0;
  for (const section of removedSections) {
    const following = byCurrentStart.find(
      (other) => other.curStart > section.curStart + EPS && other.placed,
    );
    section.delta = round3((following ? following.newStart : newEnd) - section.curStart);
  }
  for (const section of sections) {
    for (const unit of section.units) {
      if (unit.action === "keep" && section.ledger && isMoved(section.delta)) unit.action = "shift";
    }
  }
  const placedById = new Map(
    sections.filter((section) => section.placed).map((section) => [section.chapter, section]),
  );

  // ── music ────────────────────────────────────────────────────────────────
  const musicUnits: Array<
    WorkUnit & { covers: string[]; op: EditOperation | null; delta: number }
  > = [];
  const musicKeys = [
    ...new Set([
      ...intent.music.map((music) => music.node.id),
      ...(ledger?.music ?? []).map((unit) => unit.node),
    ]),
  ];
  for (const node of musicKeys) {
    const wanted = intent.music.find((music) => music.node.id === node) ?? null;
    const built = ledger?.music.find((unit) => unit.node === node) ?? null;
    const covers = (wanted?.covers ?? []).filter((chapter) => placedById.has(chapter));
    let op: EditOperation | null = null;
    const first = placedById.get(covers[0] ?? "");
    const lastCovered = placedById.get(covers.at(-1) ?? "");
    if (wanted && first && lastCovered) {
      const want = round3(lastCovered.newStart + lastCovered.newLength - first.newStart);
      let length = want;
      if (wanted.usableDuration !== null && wanted.usableDuration < want) {
        length = round3(wanted.usableDuration);
        warnings.push(
          wanted.picked
            ? `Music "${wanted.node.title}" has ${length} s inside the picked fragment ${pickedFragment(wanted.node.asset ?? "", { start: wanted.usableStart, end: round3(wanted.usableStart + wanted.usableDuration) })} but the story part it scores is ${want} s; it ends early.`
            : `Music "${wanted.node.title}" is ${length} s long but the story part it scores is ${want} s; it ends early.`,
        );
      }
      const fade = round3(Math.min(MUSIC_FADE_SECONDS, length / 2));
      op = {
        op: "add_clip",
        asset: wanted.node.asset ?? "",
        start: 0,
        track: STORY_TRACKS.music,
        duration: length,
        ...(wanted.usableStart > 0 && { mediaStart: wanted.usableStart }),
        volume: wanted.node.volume,
        fadeIn: fade,
        fadeOut: fade,
      };
    }
    const intentJson = op ? { covers, op } : null;
    const title = wanted?.node.title ?? nodes.get(node)?.title ?? node;
    let change: StorySyncChange;
    if (!built) change = intentJson ? "added" : "unchanged";
    else if (!intentJson) change = "removed";
    else change = sameJson(built.intent, intentJson) ? "unchanged" : "changed";
    if (!built && !intentJson) continue;
    const anchor = built ? currentById.get(built.covers[0] ?? "") : undefined;
    const shift = anchor?.shift ?? 0;
    const edits = built
      ? [...editsOf(built, shift, title), ...derivedEdits(`music\0${node}`, built, title)]
      : [];
    const reasons: string[] = [];
    if (change === "changed" && built && isPlainRecord(built.intent)) {
      if (!sameJson(built.intent.covers, covers)) reasons.push("scores different chapters");
      const before = built.intent.op;
      if (isPlainRecord(before) && op && op.op === "add_clip") {
        if (!sameJson(before.duration, op.duration))
          reasons.push(`length ${String(before.duration)} s → ${op.duration} s`);
        if (!sameJson(before.volume, op.volume) || !sameJson(before.asset, op.asset))
          reasons.push("track or volume changed");
      }
    }
    const unit: WorkUnit & { covers: string[]; op: EditOperation | null; delta: number } = {
      node,
      role: "music",
      title,
      ledger: built,
      intent: null,
      change,
      reasons: change === "removed" ? ["no longer attached"] : reasons,
      action: "keep",
      edits,
      present: presentOf(built),
      derived: derivedByUnit.get(`music\0${node}`) ?? [],
      nodeLocked: materialLocked(node),
      covers,
      op,
      delta: 0,
    };
    const touch = full ? true : change !== "unchanged";
    if (touch) {
      const base: StorySyncAction = op ? (built ? "rebuild" : "add") : "remove";
      const lockedOnTimeline = [...unit.present, ...unit.derived].some((clip) => clip.locked);
      if (unit.nodeLocked && built && !input.allowLocked.has(node)) unit.action = "keep_locked";
      else if (base === "add") unit.action = "add";
      else {
        if (edits.length > 0) conflictsBefore.count += 1;
        unit.action =
          lockedOnTimeline || (edits.length > 0 && !full && input.manualEdits === "keep")
            ? "keep_edited"
            : base;
      }
    }
    if (built && !TOUCHING.has(unit.action)) {
      // A bed that is not rebuilt moves with the first chapter it scores.
      unit.delta = anchor?.delta ?? 0;
      if (unit.action === "keep" && isMoved(unit.delta)) unit.action = "shift";
    }
    musicUnits.push(unit);
  }

  // ── moves ────────────────────────────────────────────────────────────────
  const moves = new Map<ClipNode, number>();
  const removals = new Set<ClipNode>();
  const move = (clip: ClipNode, delta: number) => {
    if (!isMoved(delta)) return;
    if (clip.locked) {
      warnings.push(
        `"${clipLabel(clip)}" is locked on the timeline and stays at ${round3(clip.start)} s.`,
      );
      return;
    }
    moves.set(clip, delta);
  };
  for (const section of [...sections, ...removedSections]) {
    if (!section.ledger) continue;
    for (const unit of section.units) {
      if (TOUCHING.has(unit.action)) {
        for (const clip of [...unit.present, ...unit.derived]) removals.add(clip);
      } else {
        for (const clip of [...unit.present, ...unit.derived]) move(clip, section.delta);
      }
    }
  }
  for (const unit of musicUnits) {
    if (TOUCHING.has(unit.action)) {
      for (const clip of [...unit.present, ...unit.derived]) removals.add(clip);
    } else {
      for (const clip of [...unit.present, ...unit.derived]) move(clip, unit.delta);
    }
  }
  const unrelatedReport: StoryUnrelatedClip[] = [];
  const firstBuild = !ledger;
  const placeholders: ClipNode[] = [];
  for (const clip of unrelated) {
    const home = ledger ? sectionAt(clip.start) : null;
    let delta = 0;
    if (home) delta = home.delta;
    else if (ledger && clip.start >= currentEnd - EPS) delta = tailDelta;
    if (clip.id !== "" && isUntouchedTemplatePlaceholder(clip.element)) {
      removals.add(clip);
      placeholders.push(clip);
      continue;
    }
    if (full && firstBuild && isRawAroll(clip, intent.sources)) {
      removals.add(clip);
      continue;
    }
    move(clip, delta);
    if (unrelatedReport.length < MAX_UNRELATED_REPORTED) {
      const turn = readClipProvenance(clip.element)?.turn ?? null;
      unrelatedReport.push({
        clip: ref(clip),
        label: clipLabel(clip),
        track: clip.track,
        start: round3(clip.start),
        end: round3(clip.end),
        by: turn ? "ai" : "user",
        turn,
        anchor: home?.chapter ?? null,
        shift: moves.has(clip) ? delta : 0,
      });
    }
  }
  for (const clip of placeholders) {
    warnings.push(
      `Removed the untouched template placeholder "${clipLabel(clip)}" (${round3(clip.start)}–${round3(clip.end)} s); it was not user content.`,
    );
  }
  for (const clip of staleStory) if (!clip.locked) removals.add(clip);
  const lockedLeft = staleStory.filter((clip) => clip.locked).length;
  if (lockedLeft > 0) {
    warnings.push(`${lockedLeft} locked clips from an earlier build were left in place.`);
  }

  // ── captions ─────────────────────────────────────────────────────────────
  const placedRanges = new Map<string, PlacedRange[]>();
  const addRange = (source: string, range: PlacedRange) => {
    const list = placedRanges.get(source) ?? [];
    list.push(range);
    placedRanges.set(source, list);
  };
  for (const section of sections) {
    if (!section.placed || !section.intent?.chapter.captions) continue;
    const aRoll = section.units.find((unit) => unit.role === "a_roll");
    const fresh =
      section.ledger === null ||
      (aRoll !== undefined && (TOUCHING.has(aRoll.action) || aRoll.action === "add"));
    if (fresh) {
      for (const op of aRoll?.intent?.ops ?? []) {
        if (op.op !== "add_sequence") continue;
        let at = section.newStart + (op.start ?? 0);
        for (const range of op.ranges) {
          addRange(op.asset, { from: range.from, to: range.to, at: round3(at) });
          at += range.to - range.from;
        }
      }
    } else if (aRoll) {
      for (const clip of [...aRoll.present, ...aRoll.derived]) {
        const placed = clipRange(clip, moves.get(clip) ?? 0);
        if (placed) addRange(placed.source, placed.range);
      }
    }
  }
  const cues =
    intent.captionPreset === null ? [] : cuesFor(placedRanges, input.transcripts, warnings);
  if (
    intent.captionPreset !== null &&
    cues.length === 0 &&
    intent.sections.some((section) => section.chapter.captions)
  ) {
    warnings.push("Captions were left out: the captioned chapters have no speech.");
  }

  // ── duration ─────────────────────────────────────────────────────────────
  const finalEnd = (clip: ClipNode) => clip.end + (moves.get(clip) ?? 0);
  const keptEnds = timeline.clips
    .filter((clip) => !removals.has(clip) && clip !== captionsHost)
    .map(finalEnd);
  const duration = round3(Math.max(newEnd, ...keptEnds, 0));
  const durationChanged = Math.abs(duration - timeline.duration) > LAYOUT_EPS;

  const wantCaptions = intent.captionPreset !== null && cues.length > 0;
  const builtCaptions = ledger?.captions ?? null;
  let captionsUnit: (WorkUnit & { preset: string | null }) | null = null;
  if (wantCaptions || builtCaptions) {
    let change: StorySyncChange;
    const reasons: string[] = [];
    if (!builtCaptions) change = "added";
    else if (!wantCaptions) change = "removed";
    else if (
      builtCaptions.preset !== intent.captionPreset ||
      builtCaptions.cues !== hashJson(cues)
    ) {
      change = "changed";
      reasons.push(
        builtCaptions.preset !== intent.captionPreset
          ? "preset changed"
          : "the captioned speech changed",
      );
    } else if (durationChanged) {
      change = "changed";
      reasons.push("the story's length changed");
    } else change = "unchanged";
    const edits: StoryManualEdit[] = [];
    if (builtCaptions && builtCaptions.file !== null) {
      if (!captionsHost) {
        edits.push({
          clip: builtCaptions.entity?.clip ?? "captions",
          label: "Captions",
          kind: "removed",
          by: "unknown",
          turn: null,
          fields: [],
        });
      } else if (timeline.captionsFile !== builtCaptions.file) {
        edits.push({
          clip: captionsHost.id,
          label: "Captions",
          kind: "modified",
          by: "user",
          turn: null,
          fields: ["text"],
        });
      }
    }
    let action: StorySyncAction = "keep";
    if (full || change !== "unchanged") {
      const base: StorySyncAction = wantCaptions
        ? builtCaptions || captionsHost
          ? "rebuild"
          : "add"
        : "remove";
      if (edits.length > 0 && base !== "add") conflictsBefore.count += 1;
      if (captionsHost?.locked) action = "keep_edited";
      else if (edits.length > 0 && !full && input.manualEdits === "keep" && base !== "add")
        action = "keep_edited";
      else action = base;
      if (action === "remove" && !captionsHost) action = "keep";
    }
    captionsUnit = {
      node: "captions",
      role: "captions",
      title: "Captions",
      ledger: null,
      intent: null,
      change,
      reasons: change === "removed" ? ["no captioned chapter has speech any more"] : reasons,
      action,
      edits,
      present: captionsHost ? [captionsHost] : [],
      derived: [],
      nodeLocked: false,
      preset: intent.captionPreset,
    };
    if (action === "remove" && captionsHost) removals.add(captionsHost);
  }

  // ── operations ───────────────────────────────────────────────────────────
  const operations: EditOperation[] = [];
  const removable = [...removals].filter((clip) => clip.id);
  if (removable.length > 0)
    operations.push({ op: "remove_clip", clips: removable.map((clip) => clip.id) });
  for (const [clip, delta] of moves) {
    if (removals.has(clip)) continue;
    const target = ref(clip);
    if (!target) {
      warnings.push(`"${clipLabel(clip)}" has no id and stays where it is.`);
      continue;
    }
    operations.push({ op: "move_clip", clip: target, start: round3(clip.start + delta) });
  }
  const created: Array<{ index: number; unit: WorkUnit }> = [];
  const materials: PlannedMaterial[] = [];
  const clipCount = new Map<string, number>();
  const count = (chapter: string, clips: number) =>
    clipCount.set(chapter, (clipCount.get(chapter) ?? 0) + clips);
  for (const section of sections) {
    if (!section.placed) continue;
    count(section.chapter, 0);
    for (const unit of section.units) {
      if (!unit.intent || !(unit.action === "rebuild" || unit.action === "add")) {
        if (!TOUCHING.has(unit.action))
          count(section.chapter, unit.present.length + unit.derived.length);
        continue;
      }
      for (const op of placeOps(unit.intent, section.newStart, input.turnId)) {
        created.push({ index: operations.length, unit });
        if (op.op === "add_sequence") count(section.chapter, op.ranges.length);
        else {
          count(section.chapter, 1);
          const start = op.op === "add_clip" || op.op === "add_component" ? op.start : 0;
          const length = op.op === "add_clip" || op.op === "add_component" ? (op.duration ?? 0) : 0;
          materials.push({
            node: unit.node,
            chapter: section.chapter,
            operation: operations.length,
            start,
            end: round3(start + length),
            track: op.op === "add_clip" || op.op === "add_component" ? op.track : 0,
          });
        }
        operations.push(op);
      }
    }
  }
  for (const unit of musicUnits) {
    const firstChapter = unit.covers[0] ?? "";
    const first = placedById.get(firstChapter);
    if (!unit.op || !(unit.action === "rebuild" || unit.action === "add")) {
      if (!TOUCHING.has(unit.action) && first) count(firstChapter, unit.present.length);
      continue;
    }
    if (!first || unit.op.op !== "add_clip") continue;
    created.push({ index: operations.length, unit });
    count(firstChapter, 1);
    const duration = unit.op.duration ?? 0;
    materials.push({
      node: unit.node,
      chapter: firstChapter,
      operation: operations.length,
      start: first.newStart,
      end: round3(first.newStart + duration),
      track: STORY_TRACKS.music,
    });
    operations.push({
      ...unit.op,
      start: first.newStart,
      provenance: { storyNode: unit.node, ...(input.turnId !== null && { turn: input.turnId }) },
    });
  }
  const captionsApplied =
    captionsUnit !== null &&
    (captionsUnit.action === "rebuild" || captionsUnit.action === "add") &&
    captionsUnit.preset !== null;
  const needsWrite = operations.length > 0 || durationChanged || captionsApplied;
  let captionsIndex = -1;
  if (needsWrite) {
    operations.push({ op: "set_composition", duration });
    if (captionsApplied && captionsUnit?.preset) {
      captionsIndex = operations.length;
      operations.push({ op: "apply_captions", preset: captionsUnit.preset, cues });
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  const unitReport = (unit: WorkUnit): StorySyncUnit => ({
    node: unit.node,
    role: unit.role,
    title: unit.title,
    change: unit.change,
    reasons: unit.reasons,
    action: unit.action,
    clips: unit.present.length + unit.derived.length,
    edits: unit.edits,
  });
  const sectionReport = (section: WorkSection): StorySyncSection => ({
    chapter: section.chapter,
    title: section.title,
    change: section.change,
    moved: section.ledger !== null && section.placed && isMoved(section.delta),
    locked: section.locked,
    reasons: section.reasons,
    current: section.ledger
      ? { start: section.curStart, end: round3(section.curStart + section.slot) }
      : null,
    next: section.placed
      ? { start: section.newStart, end: round3(section.newStart + section.newLength) }
      : null,
    units: section.units.map(unitReport),
  });
  const allUnits = [
    ...[...sections, ...removedSections].flatMap((section) => section.units),
    ...musicUnits,
    ...(captionsUnit ? [captionsUnit] : []),
  ];
  const affected = [...sections, ...removedSections]
    .filter((section) => section.change !== "unchanged")
    .map((section) => section.chapter);
  const moved = sections
    .filter((section) => section.change === "unchanged" && section.ledger && isMoved(section.delta))
    .map((section) => section.chapter);
  const lockedPending = [
    ...new Set(
      [...sections, ...removedSections]
        .filter((section) =>
          section.units.some(
            (unit) => unit.action === "keep_locked" && unit.change !== "unchanged",
          ),
        )
        .map((section) => section.chapter),
    ),
  ];
  const outOfSync =
    affected.length > 0 ||
    moved.length > 0 ||
    musicUnits.some((unit) => unit.change !== "unchanged") ||
    (captionsUnit !== null && captionsUnit.change !== "unchanged");
  const state: StorySyncReport["state"] = ledger
    ? outOfSync
      ? "out_of_sync"
      : "in_sync"
    : staleStory.length > 0 || captionsHost
      ? "untracked"
      : "not_built";
  const report: StorySyncReport = {
    state,
    composition: ledger?.composition ?? null,
    syncedAt: ledger?.syncedAt ?? null,
    turnId: ledger?.turnId ?? null,
    sections: [...sections, ...removedSections].map(sectionReport),
    music: musicUnits.map(unitReport),
    captions: captionsUnit ? unitReport(captionsUnit) : null,
    unrelated: unrelatedReport,
    affected,
    moved,
    lockedPending,
    manualEdits: allUnits.reduce((sum, unit) => sum + unit.edits.length, 0),
    conflicts: conflictsBefore.count,
    duration: {
      current: round3(timeline.duration),
      next: needsWrite ? duration : round3(timeline.duration),
    },
    warnings,
  };

  const replacedEdits = allUnits
    .filter((unit) => TOUCHING.has(unit.action))
    .flatMap((unit) => unit.edits);
  const keptEdits = allUnits
    .filter((unit) => unit.action === "keep_edited")
    .flatMap((unit) => unit.edits);
  // A full build reports every locked section it left as built; a rebuild those whose changes wait for permission.
  const keptLocked = full
    ? [...sections, ...removedSections]
        .filter((section) => section.units.some((unit) => unit.action === "keep_locked"))
        .map((section) => section.chapter)
    : lockedPending;
  const rebuilt = sections
    .filter((section) =>
      section.units.some((unit) => unit.action === "rebuild" || unit.action === "add"),
    )
    .map((section) => section.chapter);
  const removed = removedSections.map((section) => section.chapter);
  const plannedSections: PlannedSection[] = sections
    .filter((section) => section.placed)
    .map((section) => ({
      chapter: section.chapter,
      start: section.newStart,
      end: round3(section.newStart + section.newLength),
      clips: clipCount.get(section.chapter) ?? 0,
    }));

  // ── the ledger after the batch ───────────────────────────────────────────
  const shiftedEntities = (unit: LedgerUnit, delta: number): LedgerEntity[] =>
    unit.entities.map((entity) => {
      const clip = byId.get(entity.clip);
      // A clip locked on the timeline stays put; a vanished one keeps its record in step with its section.
      const movedBy = !clip || moves.has(clip) ? delta : 0;
      return {
        clip: entity.clip,
        state: { ...entity.state, start: round3(entity.state.start + movedBy) },
      };
    });
  const finish = (results: EditOperationResult[], after: TimelineState): SyncLedger => {
    const afterById = new Map(after.clips.filter((clip) => clip.id).map((clip) => [clip.id, clip]));
    const createdBy = new Map<WorkUnit, LedgerEntity[]>();
    for (const { index, unit } of created) {
      const result = results[index];
      const ids = result?.clipIds ?? (result?.clipId ? [result.clipId] : []);
      const list = createdBy.get(unit) ?? [];
      for (const id of ids) {
        const clip = afterById.get(id);
        if (clip) list.push({ clip: id, state: clipState(clip) });
      }
      createdBy.set(unit, list);
    }
    const ledgerUnit = (unit: WorkUnit, delta: number, intentJson: unknown): LedgerUnit | null => {
      if (unit.action === "rebuild" || unit.action === "add") {
        return {
          node: unit.node,
          role: unit.role,
          intent: intentJson,
          entities: createdBy.get(unit) ?? [],
          turnId: input.turnId,
        };
      }
      if (unit.action === "remove" || !unit.ledger) return null;
      return { ...unit.ledger, entities: shiftedEntities(unit.ledger, delta) };
    };
    const ledgerSections: LedgerSection[] = sections
      .filter((section) => section.placed)
      .map((section) => {
        const aRoll = section.units.find((unit) => unit.role === "a_roll");
        const regenerated =
          section.ledger === null ||
          (aRoll !== undefined && (TOUCHING.has(aRoll.action) || aRoll.action === "add")) ||
          Math.abs(section.newLength - section.slot) > LAYOUT_EPS;
        const length =
          regenerated && section.intent
            ? section.intent.length
            : (section.ledger?.length ?? section.newLength);
        return {
          chapter: section.chapter,
          start: section.newStart,
          length,
          units: section.units.flatMap((unit) => {
            const entry = ledgerUnit(unit, section.delta, unit.intent?.ops ?? []);
            return entry &&
              (entry.entities.length > 0 ||
                (Array.isArray(entry.intent) && entry.intent.length > 0))
              ? [entry]
              : [];
          }),
        };
      });
    const music = musicUnits.flatMap((unit) => {
      const entry = ledgerUnit(
        unit,
        unit.delta,
        unit.op ? { covers: unit.covers, op: unit.op } : null,
      );
      if (!entry) return [];
      const covers =
        unit.action === "rebuild" || unit.action === "add"
          ? unit.covers
          : (ledger?.music.find((item) => item.node === unit.node)?.covers ?? unit.covers);
      return [{ ...entry, covers }];
    });
    let captions: LedgerCaptions | null = builtCaptions;
    if (captionsUnit) {
      if (captionsIndex >= 0 && captionsUnit.preset) {
        const hostId = results[captionsIndex]?.clipId ?? null;
        const host = hostId ? afterById.get(hostId) : undefined;
        // Fingerprint the cues as a later read will see them: from the A-roll clips as written.
        const written = new Map<string, PlacedRange[]>();
        for (const section of ledgerSections) {
          const chapter = nodes.get(section.chapter);
          if (!chapter || !isChapter(chapter) || !chapter.captions) continue;
          const aRoll = section.units.find((unit) => unit.role === "a_roll");
          const derived =
            sections
              .find((work) => work.chapter === section.chapter)
              ?.units.find((unit) => unit.role === "a_roll" && !TOUCHING.has(unit.action))
              ?.derived.map((clip) => clip.id) ?? [];
          for (const id of [...(aRoll?.entities.map((entity) => entity.clip) ?? []), ...derived]) {
            const clip = afterById.get(id);
            const placed = clip ? clipRange(clip, 0) : null;
            if (!placed) continue;
            const list = written.get(placed.source) ?? [];
            list.push(placed.range);
            written.set(placed.source, list);
          }
        }
        captions = {
          preset: captionsUnit.preset,
          cues: hashJson(cuesFor(written, input.transcripts, [])),
          file: after.captionsFile,
          entity: host && hostId ? { clip: hostId, state: clipState(host) } : null,
          turnId: input.turnId,
        };
      } else if (captionsUnit.action === "remove") captions = null;
    }
    return {
      schema: SYNC_LEDGER_SCHEMA,
      composition: input.composition,
      syncedAt: input.now,
      turnId: input.turnId,
      sections: ledgerSections,
      music,
      captions,
    };
  };

  return {
    report,
    operations: needsWrite ? operations : [],
    duration: needsWrite ? duration : round3(timeline.duration),
    sections: plannedSections,
    materials,
    rebuilt,
    removed,
    moved,
    keptEdits,
    replacedEdits,
    keptLocked,
    removedClips: removable.length,
    keptClips: timeline.clips.length - removable.length,
    captions:
      captionsApplied && captionsUnit?.preset
        ? { preset: captionsUnit.preset, cues: cues.length }
        : null,
    finish,
  };
}

/** Where a video/audio clip's media plays: its source range and timeline position (moved by `delta`). */
function clipRange(clip: ClipNode, delta: number): { source: string; range: PlacedRange } | null {
  if (clip.src === null || (clip.kind !== "video" && clip.kind !== "audio")) return null;
  const from = clip.mediaStart ?? 0;
  return {
    source: clip.src,
    range: {
      from,
      to: round3(from + clip.duration * clip.playbackRate),
      at: round3(clip.start + delta),
    },
  };
}

/** Word-synced caption cues for the placed ranges of every source, in timeline order, with distinct starts. */
function cuesFor(
  placed: ReadonlyMap<string, PlacedRange[]>,
  transcripts: ReadonlyMap<string, TranscriptArtifact | null>,
  warnings: string[],
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const [source, ranges] of placed) {
    const transcript = transcripts.get(source) ?? null;
    if (!transcript) {
      warnings.push(`Captions for ${source} were left out: it has no transcript (analyze_media).`);
      continue;
    }
    cues.push(
      ...captionCuesFromWords(transcript.words, ranges, {
        sentenceEnds: new Set(transcript.sentences.map((sentence) => sentence.lastWord)),
      }),
    );
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 1; i < cues.length; i++) {
    const previous = cues[i - 1];
    const cue = cues[i];
    if (previous && cue && cue.start <= previous.start) cue.start = round3(previous.start + 0.001);
  }
  return cues;
}

/** The raw A-roll a first build replaces: unlocked clips of the story's sources on the A-roll track. */
function isRawAroll(clip: ClipNode, sources: ReadonlySet<string>): boolean {
  return (
    !clip.locked && clip.track === STORY_TRACKS.aRoll && clip.src !== null && sources.has(clip.src)
  );
}
