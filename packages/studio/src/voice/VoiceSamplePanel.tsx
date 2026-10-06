import { useId, useState } from "react";
import { Columns, Trash } from "@phosphor-icons/react";
import { VOICE_LIMITS } from "@hyperframes/agent-protocol";
import { Button, IconButton, Spinner, cn } from "../components/ui";
import { formatDuration, useTranslation } from "../i18n";
import { VoicePlayButton, type VoiceSoundSource } from "./VoicePlayButton";
import { sampleKey, type VoiceDraft } from "./voiceDraft";
import { usdOrUnknown } from "./voiceLabels";
import type { SampleEntry } from "./useVoiceSamples";
import type { VoiceSetup } from "./useVoiceSetup";

/** At most this many voices are compared side by side. */
export const MAX_COMPARED = 3;

interface Compared {
  id: number;
  draft: VoiceDraft;
}

const sameVoice = (a: VoiceDraft, b: VoiceDraft) => sampleKey(a, "") === sampleKey(b, "");

/** The sound of a finished sample, or null while it is not there. */
function soundOf(entry: SampleEntry | null): VoiceSoundSource | null {
  return entry?.status === "ready" && entry.result ? { url: entry.result.audio.url } : null;
}

/** What a sample cost: free when the cache answered, else the provider's price or that it is not known. */
function SampleFacts({ entry }: { entry: SampleEntry }) {
  const { t } = useTranslation();
  if (entry.status === "loading")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-3" role="status">
        <Spinner size="sm" />
        {t("voice.sample.making")}
      </span>
    );
  if (entry.status === "failed" || !entry.result)
    return (
      <span role="alert" className="text-xs text-error">
        {entry.message ?? t("voice.sample.failed")}
      </span>
    );
  const { audio, cached, usdCost } = entry.result;
  return (
    <span className="text-xs tabular-nums text-fg-3">
      {formatDuration(audio.durationSeconds)} ·{" "}
      {cached ? t("voice.sample.cached") : usdOrUnknown(usdCost)}
    </span>
  );
}

/**
 * The window's listening half. The preview is always the real thing: the voice, style and settings of the draft
 * speaking the user's own phrase (`POST /api/voice/sample`, the same request a take makes). Two to three voices can
 * be kept side by side on the same phrase, and "Listen with video" plays the sample from the playhead together with
 * the composition (nothing is added to the timeline).
 */
export function VoiceSamplePanel({ setup }: { setup: VoiceSetup }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const { draft, text, samples } = setup;
  const [compared, setCompared] = useState<Compared[]>([]);
  const [nextId, setNextId] = useState(1);
  const phrase = text.trim();
  const ready = draft.voice !== null && phrase !== "";
  const entry = setup.currentSample;

  const sampleOf = async (target: VoiceDraft) => soundOf(await samples.ensure(target, text));

  const addToComparison = () => {
    if (!ready || compared.length >= MAX_COMPARED) return;
    if (compared.some((item) => sameVoice(item.draft, draft))) return;
    setCompared((items) => [...items, { id: nextId, draft }]);
    setNextId((id) => id + 1);
    void samples.ensure(draft, text);
  };

  return (
    <section
      className="grid gap-2"
      aria-label={t("voice.section.sample")}
      data-testid="voice-sample-panel"
    >
      <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.04em] text-fg-3">
        {t("voice.section.sample")}
      </h3>
      <label htmlFor={fieldId} className="sr-only">
        {t("voice.sample.phrase")}
      </label>
      <textarea
        id={fieldId}
        value={text}
        rows={2}
        maxLength={VOICE_LIMITS.sampleTextChars}
        onChange={(event) => setup.setText(event.target.value)}
        className={cn(
          "min-h-10 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden",
          "placeholder:text-fg-disabled hover:border-border-strong",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        )}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <VoicePlayButton
          soundKey="voice-setup:sample"
          label={t("voice.sample.listen")}
          variant="text"
          disabled={!ready}
          source={() => sampleOf(draft)}
        />
        <VoicePlayButton
          soundKey="voice-setup:sample-video"
          label={t("voice.sample.listenWithVideo")}
          variant="text"
          withVideo
          disabled={!ready}
          source={() => sampleOf(draft)}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<Columns size={12} aria-hidden />}
          disabled={
            !ready ||
            compared.length >= MAX_COMPARED ||
            compared.some((item) => sameVoice(item.draft, draft))
          }
          onClick={addToComparison}
        >
          {t("voice.sample.compare")}
        </Button>
        {entry !== null && <SampleFacts entry={entry} />}
      </div>
      {draft.voice === null && (
        <p className="m-0 text-xs leading-[15px] text-fg-3">{t("voice.sample.chooseFirst")}</p>
      )}
      {compared.length > 0 && (
        <div
          role="group"
          aria-label={t("voice.compare.title")}
          className="grid gap-1.5 sm:grid-cols-3"
          data-testid="voice-compare"
        >
          {compared.map((item) => {
            const result = samples.entries[sampleKey(item.draft, text)] ?? null;
            const chosen = sameVoice(item.draft, draft);
            return (
              <div
                key={item.id}
                data-compared={item.draft.voice?.id}
                className={cn(
                  "grid min-w-0 gap-1 rounded-md border bg-bg-0 p-2",
                  chosen ? "border-border-strong" : "border-border-subtle",
                )}
              >
                <div className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {item.draft.voice?.name ?? ""}
                  </span>
                  <IconButton
                    size="xs"
                    aria-label={t("voice.compare.remove", { name: item.draft.voice?.name ?? "" })}
                    icon={<Trash size={12} aria-hidden />}
                    onClick={() =>
                      setCompared((items) => items.filter((other) => other.id !== item.id))
                    }
                  />
                </div>
                {result !== null && <SampleFacts entry={result} />}
                <div className="flex items-center gap-1">
                  <VoicePlayButton
                    soundKey={`voice-setup:compare:${item.id}`}
                    label={t("voice.compare.play", { name: item.draft.voice?.name ?? "" })}
                    variant="text"
                    size="xs"
                    source={() => sampleOf(item.draft)}
                  >
                    {t("voice.compare.playShort")}
                  </VoicePlayButton>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={chosen}
                    onClick={() => setup.adopt(item.draft)}
                  >
                    {chosen ? t("voice.compare.current") : t("voice.compare.use")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
