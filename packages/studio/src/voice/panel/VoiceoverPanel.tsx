import { useState } from "react";
import { Lock, Microphone, Plus, WarningCircle } from "@phosphor-icons/react";
import { isBetaFeatureEnabled } from "../../betaFeatures";
import { Button, Input, Spinner } from "../../components/ui";
import { useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { voiceClipsOfLine } from "../clip/voiceClipPatch";
import { useVoiceClipOpsContext } from "../clip/voiceClipOpsContext";
import { selectedTakeOf } from "../script/voiceScriptStore";
import { useVoiceEditLock, useVoiceScript } from "../script/useVoiceScript";
import { VoiceCarveButton } from "./VoiceCarveButton";
import { VoiceGenerate } from "./VoiceGenerate";
import { VoiceIssueList } from "./VoiceIssueList";
import { VoiceLineCard } from "./VoiceLineCard";
import { VoiceProjectVoice } from "./VoiceProjectVoice";
import { useVoiceLineEdits } from "./useVoiceLineEdits";
import { useVoiceTakeActions } from "./useVoiceTakeActions";

/**
 * The Voiceover tab: the project's script. The voice and language at the top, then every line with its text (tags as
 * chips), its takes and what the last dialect check found, and the actions that spend money or touch the timeline
 * (Generate missing, Regenerate, Add to timeline, Carve music) each asking or saying why they cannot. Beta only.
 */
export function VoiceoverPanel({ projectId }: { projectId: string }) {
  if (!isBetaFeatureEnabled("voiceover")) return null;
  return <VoiceoverPanelBody projectId={projectId} />;
}

function VoiceoverPanelBody({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const state = useVoiceScript(projectId);
  const { locked, reason } = useVoiceEditLock();
  const edits = useVoiceLineEdits();
  const actions = useVoiceTakeActions();
  const clips = useVoiceClipOpsContext();
  const elements = usePlayerStore((current) => current.elements);
  const [draft, setDraft] = useState("");
  const { view, check } = state;

  if (view === null) {
    return (
      <div
        data-testid="voiceover-panel"
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-fg-3"
      >
        {state.loadError !== null ? (
          <>
            <p role="alert" className="m-0 flex items-center gap-1 text-error">
              <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
              {state.loadError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void state.reload()}>
              {t("common.tryAgain")}
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <Spinner size="sm" />
            {t("voice.panel.loading")}
          </span>
        )}
      </div>
    );
  }

  const missing = view.lines.filter((line) => line.selectedTakeId === null || line.textChanged);
  const pendingOnServer = check
    ? Math.max(0, check.estimate.lines - check.estimate.cachedLines)
    : 0;
  const toGenerate = Math.max(missing.length, pendingOnServer);
  const unplaced = view.lines.flatMap((line) => {
    const take = selectedTakeOf(line);
    return take && line.clipIds.length === 0 && voiceClipsOfLine(elements, line.id).length === 0
      ? [{ lineId: line.id, take }]
      : [];
  });
  const scriptIssues = (check?.issues ?? []).filter((issue) => issue.lineId === null);
  const busy = locked || state.writing;

  const submit = async () => {
    const text = draft.trim();
    if (text === "" || busy) return;
    if (await edits.addLine(text)) setDraft("");
  };

  return (
    <div
      data-testid="voiceover-panel"
      className="flex h-full min-h-0 flex-col bg-bg-0 text-sm text-fg"
    >
      {locked && (
        <p
          role="status"
          data-testid="voiceover-locked"
          className="m-0 flex items-start gap-1.5 border-b border-border-subtle bg-surface-1 px-3 py-1.5 text-xs leading-[15px] text-fg-2"
        >
          <Lock aria-hidden className="mt-px size-icon-sm shrink-0" />
          {reason}
        </p>
      )}
      <div className="grid flex-none gap-2 border-b border-border-subtle px-3 py-2.5">
        <VoiceProjectVoice view={view} />
        <label className="flex items-center gap-2 text-xs text-fg-3">
          <span className="shrink-0">{t("voice.panel.language")}</span>
          <Input
            aria-label={t("voice.panel.language")}
            data-testid="voiceover-language"
            value={view.language ?? ""}
            placeholder={t("voice.panel.languagePlaceholder")}
            disabled={busy}
            title={reason ?? undefined}
            maxLength={35}
            className="min-w-0 flex-1"
            onCommit={(next) => void edits.setLanguage(next.trim() === "" ? null : next.trim())}
          />
        </label>
        <VoiceIssueList issues={scriptIssues} testId="voiceover-script-issues" />
        <div className="flex flex-wrap items-start gap-1.5">
          <VoiceGenerate
            force={false}
            label={
              toGenerate > 0
                ? t("voice.panel.generateMissing", { count: toGenerate })
                : t("voice.panel.generateMissingNone")
            }
            variant="primary"
            disabledReason={
              view.voice === null
                ? t("voice.panel.needsVoice")
                : toGenerate === 0
                  ? t("voice.panel.nothingMissing")
                  : null
            }
            onGenerated={actions.followGenerated}
            testId="voiceover-generate"
          />
          {unplaced.length > 0 && clips !== null && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus aria-hidden size={12} />}
              data-testid="voiceover-add-all"
              disabled={busy}
              title={reason ?? undefined}
              onClick={() => void clips.addLines(unplaced)}
            >
              {t("voice.panel.addAll", { count: unplaced.length })}
            </Button>
          )}
        </div>
        <VoiceCarveButton />
        {(edits.error ?? actions.error) !== null && (
          <p role="alert" className="m-0 text-xs leading-[15px] text-error">
            {edits.error ?? actions.error}
          </p>
        )}
      </div>

      {view.lines.length === 0 ? (
        <div
          data-testid="voiceover-empty"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-fg-3"
        >
          <Microphone aria-hidden size={22} />
          <p className="m-0 text-sm [text-wrap:balance]">{t("voice.panel.empty")}</p>
        </div>
      ) : (
        <ol
          data-testid="voiceover-lines"
          className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0"
        >
          {view.lines.map((line, index) => (
            <VoiceLineCard
              key={line.id}
              line={line}
              index={index}
              count={view.lines.length}
              projectId={projectId}
              dialect={view.voice ? view.dialect : null}
              hasVoice={view.voice !== null}
              writing={state.writing}
            />
          ))}
        </ol>
      )}

      <div className="grid flex-none gap-1.5 border-t border-border-subtle px-3 py-2.5">
        <label htmlFor="voiceover-new-line" className="text-xs font-medium text-fg-3">
          {t("voice.panel.newLine")}
        </label>
        <textarea
          id="voiceover-new-line"
          data-testid="voiceover-new-line"
          value={draft}
          rows={2}
          maxLength={10_000}
          disabled={busy}
          title={reason ?? undefined}
          placeholder={t("voice.panel.newLinePlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          className="min-h-10 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden placeholder:text-fg-disabled hover:border-border-strong focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-disabled"
        />
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus aria-hidden size={12} />}
            data-testid="voiceover-add-line"
            disabled={busy || draft.trim() === ""}
            title={reason ?? undefined}
            onClick={() => void submit()}
          >
            {t("voice.panel.addLine")}
          </Button>
        </div>
      </div>
    </div>
  );
}
