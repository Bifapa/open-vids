/**
 * SlideshowSubPanels — internal sub-surface components for SlideshowPanel.
 * Not exported from the package index; used only by SlideshowPanel.tsx.
 */

import { useState, useCallback, useId } from "react";
import type { SlideRef, SlideSequence } from "@hyperframes/core/slideshow";
import type { SceneInfo } from "./slideshowPanelHelpers";
import { CaretDown, X } from "@phosphor-icons/react";
import { buttonBase, buttonSizes, buttonVariants } from "../ui/Button";
import { INSP_CHIP, INSP_FOCUS_INSET, INSP_MINI_BUTTON } from "../editor/inspectorStyles";
import { formatNumber, useTranslation } from "../../i18n";
import { SLIDE_BUTTON, SLIDE_FIELD } from "./slideshowStyles";

/** Scene start as mm:ss, the way the prototype's slide list shows it. */
function formatSlideTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

// ── Section header (accordion toggle) ────────────────────────────────────

export function SectionHeader({
  children,
  expanded,
  onToggle,
}: {
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex h-[30px] w-full shrink-0 items-center gap-1 border-b border-border-subtle pr-2.5 pl-2 text-left text-sm font-semibold text-fg transition-colors hover:bg-surface-1 ${INSP_FOCUS_INSET}`}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <CaretDown
        size={12}
        aria-hidden="true"
        className={`shrink-0 text-fg-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
      />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

// ── Sub-surface: Slide List ──────────────────────────────────────────────

export interface SlideListProps {
  scenes: SceneInfo[];
  slides: SlideRef[];
  selectedSceneId: string | null;
  onSelect: (sceneId: string) => void;
  onToggle: (sceneId: string) => void;
  onReorder: (sceneId: string, dir: "up" | "down") => void;
}

export function SlideList({
  scenes,
  slides,
  selectedSceneId,
  onSelect,
  onToggle,
  onReorder,
}: SlideListProps) {
  const { t } = useTranslation();
  const slideIds = new Set(slides.map((s) => s.sceneId));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const orderedSlideScenes = slides
    .map((sl) => sceneById.get(sl.sceneId))
    .filter((s): s is SceneInfo => s !== undefined);
  const nonSlideScenes = scenes.filter((sc) => !slideIds.has(sc.id));
  const rows = [...orderedSlideScenes, ...nonSlideScenes];
  return (
    <div className="grid gap-px px-1.5 py-1">
      {rows.map((scene) => {
        const isSlide = slideIds.has(scene.id);
        const isSelected = selectedSceneId === scene.id;
        const slideIndex = slides.findIndex((s) => s.sceneId === scene.id);
        return (
          <div
            key={scene.id}
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            className={`group flex h-row-sm cursor-pointer items-center gap-2 rounded-sm border px-1.5 text-sm transition-colors ${INSP_FOCUS_INSET} ${
              isSelected
                ? "border-accent-line bg-accent-soft text-fg"
                : "border-transparent hover:bg-surface-1"
            } ${isSlide ? "text-fg" : "text-fg-3"}`}
            onClick={() => onSelect(scene.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(scene.id);
              }
            }}
          >
            <input
              type="checkbox"
              aria-label={t("panels.slideshow.list.include", { scene: scene.label })}
              checked={isSlide}
              onChange={() => onToggle(scene.id)}
              onClick={(e) => e.stopPropagation()}
              className="size-3.5 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1 truncate">{scene.label || scene.id}</span>
            <span className="shrink-0 font-mono text-num text-fg-3 tabular-nums">
              {formatSlideTime(scene.start)}
            </span>
            {isSlide && (
              <span className="flex shrink-0">
                <button
                  type="button"
                  aria-label={t("panels.slideshow.list.moveUpLabel")}
                  title={t("panels.slideshow.list.moveUp")}
                  disabled={slideIndex <= 0}
                  className={`${INSP_MINI_BUTTON} w-4`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReorder(scene.id, "up");
                  }}
                >
                  <CaretDown size={10} aria-hidden="true" className="rotate-180" />
                </button>
                <button
                  type="button"
                  aria-label={t("panels.slideshow.list.moveDownLabel")}
                  title={t("panels.slideshow.list.moveDown")}
                  disabled={slideIndex === slides.length - 1}
                  className={`${INSP_MINI_BUTTON} w-4`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReorder(scene.id, "down");
                  }}
                >
                  <CaretDown size={10} aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
        );
      })}
      {scenes.length === 0 && (
        <p className="m-0 px-1.5 py-2 text-sm text-fg-3">{t("panels.slideshow.list.empty")}</p>
      )}
    </div>
  );
}

// ── Sub-surface: Slide Inspector ─────────────────────────────────────────

export interface SlideInspectorProps {
  sceneId: string;
  slide: SlideRef | undefined;
  currentTime: number;
  onSetNotes: (notes: string) => void;
  onMarkFragment: () => void;
  onRemoveFragment: (time: number) => void;
}

export function SlideInspector({
  sceneId,
  slide,
  currentTime,
  onSetNotes,
  onMarkFragment,
  onRemoveFragment,
}: SlideInspectorProps) {
  const { t } = useTranslation();
  const fragments = slide?.fragments ?? [];
  const formatSeconds = (seconds: number) =>
    formatNumber(seconds, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    });
  return (
    <div className="grid gap-2 px-3 py-2">
      <p className="m-0 truncate font-mono text-num text-fg-3">
        {t("panels.slideshow.inspector.scene", { id: sceneId })}
      </p>
      <div className="grid gap-1">
        <label className="text-sm text-fg-3">{t("panels.slideshow.inspector.notes")}</label>
        <textarea
          className={`${SLIDE_FIELD} min-h-[60px] resize-y py-1.5`}
          rows={3}
          placeholder={t("panels.slideshow.inspector.notesPlaceholder")}
          value={slide?.notes ?? ""}
          onChange={(e) => onSetNotes(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-fg-3">{t("panels.slideshow.inspector.fragments")}</span>
          <button
            type="button"
            className={SLIDE_BUTTON}
            onClick={onMarkFragment}
            title={t("panels.slideshow.inspector.markTitle", { time: formatSeconds(currentTime) })}
          >
            {t("panels.slideshow.inspector.mark", { time: formatSeconds(currentTime) })}
          </button>
        </div>
        {fragments.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {fragments.map((time, i) => (
              <span
                key={`frag-${i}`}
                className={`${INSP_CHIP} inline-flex items-center gap-1 pr-0.5 font-mono text-num`}
              >
                {t("panels.slideshow.inspector.seconds", { time: formatSeconds(time) })}
                <button
                  type="button"
                  aria-label={t("panels.slideshow.inspector.removeFragment", {
                    time: formatSeconds(time),
                  })}
                  className={`${INSP_MINI_BUTTON} size-4 hover:text-error`}
                  onClick={() => onRemoveFragment(time)}
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="m-0 text-xs text-fg-3">{t("panels.slideshow.inspector.noFragments")}</p>
        )}
      </div>
    </div>
  );
}

// ── Sub-surface: Branch Tree ──────────────────────────────────────────────

export interface BranchTreeProps {
  sequences: SlideSequence[];
  scenes: SceneInfo[];
  onCreateSequence: (label: string) => void;
  onRenameSequence: (id: string, label: string) => void;
  onDeleteSequence: (id: string) => void;
  onAssign: (sequenceId: string, sceneId: string, assign: boolean) => void;
  selectedSceneId: string | null;
  selectedSequenceId: string | null;
  onSelectBranchSlide: (sequenceId: string, sceneId: string) => void;
}

export function BranchTree({
  sequences,
  scenes,
  onCreateSequence,
  onRenameSequence,
  onDeleteSequence,
  onAssign,
  selectedSceneId,
  selectedSequenceId,
  onSelectBranchSlide,
}: BranchTreeProps) {
  const { t } = useTranslation();
  const [newLabel, setNewLabel] = useState("");
  const inputId = useId();

  const handleCreate = useCallback(() => {
    const label = newLabel.trim();
    if (!label) return;
    onCreateSequence(label);
    setNewLabel("");
  }, [newLabel, onCreateSequence]);

  return (
    <div className="grid gap-2 px-3 py-2">
      <div className="flex gap-1.5">
        <input
          id={inputId}
          type="text"
          className={`${SLIDE_FIELD} h-ctl-sm flex-1`}
          placeholder={t("panels.slideshow.branch.newPlaceholder")}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          aria-label={t("panels.slideshow.branch.newLabel")}
        />
        <button type="button" className={SLIDE_BUTTON} onClick={handleCreate}>
          {t("common.add")}
        </button>
      </div>

      {sequences.length === 0 ? (
        <p className="text-xs text-fg-disabled italic">{t("panels.slideshow.branch.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {sequences.map((seq) => (
            <BranchItem
              key={seq.id}
              seq={seq}
              scenes={scenes}
              onRename={onRenameSequence}
              onDelete={onDeleteSequence}
              onAssign={onAssign}
              selectedSceneId={selectedSceneId}
              selectedSequenceId={selectedSequenceId}
              onSelectBranchSlide={onSelectBranchSlide}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface BranchItemProps {
  seq: SlideSequence;
  scenes: SceneInfo[];
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onAssign: (sequenceId: string, sceneId: string, assign: boolean) => void;
  selectedSceneId: string | null;
  selectedSequenceId: string | null;
  onSelectBranchSlide: (sequenceId: string, sceneId: string) => void;
}

function BranchItem({
  seq,
  scenes,
  onRename,
  onDelete,
  onAssign,
  selectedSceneId,
  selectedSequenceId,
  onSelectBranchSlide,
}: BranchItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seq.label);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const commitRename = useCallback(() => {
    const label = draft.trim();
    if (label && label !== seq.label) onRename(seq.id, label);
    setEditing(false);
  }, [draft, onRename, seq.id, seq.label]);

  return (
    <div className="grid gap-1.5 rounded-md border border-border bg-bg-1 p-2">
      <div className="flex items-center gap-1">
        {editing ? (
          <input
            className={`${SLIDE_FIELD} h-ctl-sm flex-1`}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label={t("panels.slideshow.branch.renameLabel", { name: seq.label })}
          />
        ) : (
          <span
            role="button"
            tabIndex={0}
            className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium text-fg hover:text-fg-2"
            title={t("panels.slideshow.branch.renameHint")}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setEditing(true);
              }
            }}
          >
            {seq.label}
          </span>
        )}
        <button
          type="button"
          aria-label={t("panels.slideshow.branch.deleteLabel", { name: seq.label })}
          className={`${INSP_MINI_BUTTON} hover:text-error`}
          onClick={() => setConfirmingDelete(true)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {confirmingDelete && (
        <div className="grid gap-1 rounded-sm border border-error/35 bg-error-soft px-2 py-1.5">
          <span className="text-xs text-fg-2">
            {t("panels.slideshow.branch.confirmDelete", {
              name: seq.label,
              count: seq.slides.length,
            })}
          </span>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete(seq.id);
              }}
              className={`${buttonBase} ${buttonVariants.danger} ${buttonSizes.xs}`}
            >
              {t("common.delete")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className={`${buttonBase} ${buttonVariants.ghost} ${buttonSizes.xs}`}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-px pl-2">
        {scenes.map((scene) => {
          const assigned = seq.slides.some((s) => s.sceneId === scene.id);
          const isSelected = selectedSequenceId === seq.id && selectedSceneId === scene.id;
          return (
            <div key={scene.id} className="flex items-center gap-1.5 py-0.5 text-sm text-fg-2">
              <input
                type="checkbox"
                aria-label={t("panels.slideshow.branch.assignLabel", {
                  scene: scene.label || scene.id,
                  branch: seq.label,
                })}
                checked={assigned}
                onChange={(e) => onAssign(seq.id, scene.id, e.target.checked)}
                className="accent-accent shrink-0"
              />
              {assigned ? (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  className={`flex-1 text-left truncate transition-colors hover:text-fg ${
                    isSelected ? "text-fg" : "text-fg-2"
                  }`}
                  onClick={() => onSelectBranchSlide(seq.id, scene.id)}
                >
                  {scene.label || scene.id}
                </button>
              ) : (
                <span className="flex-1 truncate">{scene.label || scene.id}</span>
              )}
            </div>
          );
        })}
        {scenes.length === 0 && (
          <p className="text-xs text-fg-disabled italic">{t("panels.slideshow.branch.noScenes")}</p>
        )}
      </div>
    </div>
  );
}
