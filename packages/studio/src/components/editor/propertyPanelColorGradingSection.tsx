import { type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { isHfColorGradingActive } from "@hyperframes/core/color-grading";
import { Compare, Palette, RotateCcw } from "../../icons/SystemIcons";
import type { DomEditSelection } from "./domEditing";
import { ColorGradingControls } from "./propertyPanelColorGradingControls";
import { Section } from "./propertyPanelPrimitives";
import {
  useColorGradingController,
  type MediaMetadata,
  type RuntimeColorGradingStatus,
} from "./useColorGradingController";
import { gradeStatusText } from "./propertyPanelGradeStatus";
import { useTranslation } from "../../i18n";

function StatusPill({ status }: { status: RuntimeColorGradingStatus }) {
  const dotClass =
    status.state === "active"
      ? "bg-emerald-400"
      : status.state === "pending"
        ? "bg-amber-300"
        : status.state === "unavailable"
          ? "bg-red-400"
          : "bg-panel-text-5";
  const statusText = gradeStatusText(status.message);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-sm bg-surface-1 px-2 py-1 text-xs font-medium text-fg-3"
      title={statusText}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="truncate">{statusText}</span>
    </div>
  );
}

function HdrMediaWarning({ metadata }: { metadata: MediaMetadata | null }) {
  const { t } = useTranslation();
  if (metadata?.color.dynamicRange !== "hdr") return null;
  const details = [
    metadata.color.codecName,
    metadata.color.profile,
    metadata.color.pixelFormat,
    metadata.color.colorPrimaries,
    metadata.color.colorTransfer,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm leading-4 text-amber-100">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
        <span className="font-semibold">
          {t("inspector.grade.hdrSource", { label: metadata.color.label })}
        </span>
        <span className="rounded-sm bg-amber-400/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-amber-100">
          {t("inspector.grade.sdrPreview")}
        </span>
      </div>
      <p className="text-amber-100/80">{t("inspector.grade.hdrNote")}</p>
      {details && <p className="mt-1 truncate text-xs text-amber-100/55">{details}</p>}
    </div>
  );
}

function HoldBeforeButton({
  active,
  disabled,
  onHoldChange,
}: {
  active: boolean;
  disabled: boolean;
  onHoldChange: (holding: boolean) => void;
}) {
  const { t } = useTranslation();
  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onHoldChange(true);
    const release = () => {
      onHoldChange(false);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
  };
  const stopHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onHoldChange(false);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      aria-label={t("inspector.grade.holdToCompare")}
      onPointerDown={startHold}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      onBlur={() => {
        if (active) onHoldChange(false);
      }}
      onKeyDown={(event) => {
        if (disabled || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        if (!active) {
          onHoldChange(true);
        }
      }}
      onKeyUp={(event) => {
        if (disabled || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        onHoldChange(false);
      }}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
        active ? "bg-studio-accent text-black" : "text-fg-3 hover:bg-surface-2 hover:text-fg"
      } disabled:cursor-not-allowed disabled:opacity-40`}
      title={t("inspector.grade.holdToCompare")}
    >
      <Compare size={13} />
    </button>
  );
}

export function ColorGradingSection({
  projectId,
  element,
  assets,
  previewIframeRef,
  onImportAssets,
  onSetAttributeLive,
  onApplyScope,
}: {
  projectId: string;
  element: DomEditSelection;
  assets: string[];
  previewIframeRef?: RefObject<HTMLIFrameElement | null>;
  onImportAssets?: (files: FileList, dir?: string) => Promise<string[]>;
  onSetAttributeLive: (
    attr: string,
    value: string | null,
    onSettled?: (ok: boolean) => void,
  ) => void | Promise<void>;
  onApplyScope?: (
    scope: "source-file" | "project",
    value: string | null,
  ) => Promise<{ changedFiles: number; changedElements: number }>;
}) {
  const { t } = useTranslation();
  const {
    grading,
    compareEnabled,
    applyScope,
    applyBusy,
    runtimeStatus,
    mediaMetadata,
    commitColorGrading,
    commitCompare,
    setApplyScope,
    applyToScope,
    resetGrading,
  } = useColorGradingController({
    projectId,
    element,
    previewIframeRef,
    onSetAttributeLive,
    onApplyScope,
  });

  return (
    <Section
      title={t("inspector.grade.title")}
      icon={<Palette size={15} />}
      accessory={
        <div className="flex min-w-0 items-center gap-1.5">
          <HoldBeforeButton
            active={compareEnabled}
            disabled={!isHfColorGradingActive(grading)}
            onHoldChange={commitCompare}
          />
          <StatusPill status={runtimeStatus} />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              resetGrading();
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg"
            title={t("inspector.grade.reset")}
          >
            <RotateCcw size={12} />
          </button>
        </div>
      }
    >
      <HdrMediaWarning metadata={mediaMetadata} />
      <ColorGradingControls
        grading={grading}
        assets={assets}
        onImportAssets={onImportAssets}
        onCommitColorGrading={commitColorGrading}
      />
      {onApplyScope && (
        <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <select
            value={applyScope}
            onChange={(event) => {
              setApplyScope(event.currentTarget.value as typeof applyScope);
            }}
            disabled={applyBusy}
            className="w-full min-w-0 rounded-md bg-surface-1 px-3 py-2 text-sm font-medium text-fg outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
            title={t("inspector.grade.scopeHint")}
          >
            <option value="source-file">{t("inspector.grade.scopeFile")}</option>
            <option value="project">{t("inspector.grade.scopeProject")}</option>
          </select>
          <button
            type="button"
            disabled={applyBusy}
            onClick={(event) => {
              event.stopPropagation();
              void applyToScope();
            }}
            className="h-8 rounded-md bg-surface-1 px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            title={t("inspector.grade.applyHint")}
          >
            {applyBusy ? t("inspector.grade.applying") : t("inspector.grade.apply")}
          </button>
        </div>
      )}
    </Section>
  );
}
