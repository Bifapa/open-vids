import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react";
import type {
  VoiceCatalogEntry,
  VoiceCatalogFilter,
  VoicePresetVoice,
  VoiceProviderId,
} from "@hyperframes/agent-protocol";
import { Badge, Button, Input, Select, Spinner, cn } from "../components/ui";
import { useTranslation } from "../i18n";
import { useVoiceClient } from "./voiceContext";
import {
  languageFilter,
  languageFilterValue,
  presetVoiceOf,
  type CatalogControl,
} from "./voiceDraft";
import { entryChips, filterLabel } from "./voiceLabels";
import { VoicePlayButton } from "./VoicePlayButton";

/** The "any" option of a filter's select (an empty value cannot be a select item). */
const ANY = "__any__";

interface CatalogState {
  entries: VoiceCatalogEntry[];
  nextPageToken: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: CatalogState = { entries: [], nextPageToken: null, loading: true, error: null };

/** The filters a catalog opens with: the script's language, when the provider can filter by one. */
function initialFilters(control: CatalogControl, language: string | null): Record<string, string> {
  const filter = languageFilter(control.filters);
  if (!filter || !language) return {};
  const value = languageFilterValue(filter, language);
  return value === null ? {} : { [filter.id]: value };
}

function FilterField({
  filter,
  value,
  onChange,
}: {
  filter: VoiceCatalogFilter;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const label = filterLabel(filter.id);
  if (filter.options === null) {
    return (
      <Input
        value={value}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        onCommit={onChange}
        className="w-36"
      />
    );
  }
  const options = [
    { value: ANY, label: t("voice.catalog.any", { filter: label }) },
    ...filter.options.map((option) => ({ value: option, label: option })),
  ];
  return (
    <Select
      label={label}
      value={value === "" ? ANY : value}
      options={options}
      onCommit={(next) => onChange(next === ANY ? "" : next)}
      className="w-36"
    />
  );
}

/**
 * The provider's voice catalog: its filters (a script's language applied to the language filter at first), a list of
 * voices with the characteristics the provider gave, and a free demo for the voices that have one. Choosing a voice
 * only picks it; what it sounds like speaking the user's own phrase is the sample's job.
 */
export function VoiceCatalogPicker({
  control,
  providerId,
  model,
  language,
  selectedId,
  onSelect,
}: {
  control: CatalogControl;
  providerId: VoiceProviderId;
  model: string;
  language: string | null;
  selectedId: string | null;
  onSelect: (voice: VoicePresetVoice) => void;
}) {
  const { t } = useTranslation();
  const client = useVoiceClient();
  const [filters, setFilters] = useState(() => initialFilters(control, language));
  const [state, setState] = useState<CatalogState>(EMPTY);
  const [reload, setReload] = useState(0);
  const filtersKey = useMemo(() => JSON.stringify(Object.entries(filters).sort()), [filters]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // A catalog of another provider starts from its own filters.
  useEffect(() => {
    setFilters(initialFilters(control, language));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a provider change resets the filters
  }, [providerId]);

  useEffect(() => {
    const controller = new AbortController();
    setState(EMPTY);
    client
      .voices(providerId, { filters: filtersRef.current, model }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          entries: page.voices,
          nextPageToken: page.nextPageToken,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          entries: [],
          nextPageToken: null,
          loading: false,
          error: error instanceof Error ? error.message : t("voice.catalog.failed"),
        });
      });
    return () => controller.abort();
  }, [client, providerId, model, filtersKey, reload, t]);

  const more = async () => {
    if (state.nextPageToken === null) return;
    setState((current) => ({ ...current, loading: true }));
    try {
      const page = await client.voices(providerId, {
        filters: filtersRef.current,
        model,
        pageToken: state.nextPageToken,
      });
      setState((current) => ({
        entries: [...current.entries, ...page.voices],
        nextPageToken: page.nextPageToken,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : t("voice.catalog.failed"),
      }));
    }
  };

  return (
    <div className="grid gap-2" data-voice-control="catalog">
      {control.filters.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("voice.catalog.filters")}
        >
          {control.filters.map((filter) => (
            <FilterField
              key={filter.id}
              filter={filter}
              value={filters[filter.id] ?? ""}
              onChange={(next) => setFilters((current) => ({ ...current, [filter.id]: next }))}
            />
          ))}
        </div>
      )}
      <div
        className="max-h-[220px] overflow-y-auto overscroll-contain rounded-md border border-border-subtle bg-bg-0"
        data-testid="voice-catalog"
      >
        {state.error !== null && (
          <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-error">
            <span className="min-w-0 flex-1">
              {t("voice.catalog.error", { message: state.error })}
            </span>
            <Button size="xs" variant="ghost" onClick={() => setReload((count) => count + 1)}>
              {t("common.tryAgain")}
            </Button>
          </div>
        )}
        {state.error === null && !state.loading && state.entries.length === 0 && (
          <p className="m-0 px-3 py-3 text-xs text-fg-3" role="status">
            {t("voice.catalog.empty")}
          </p>
        )}
        <ul className="m-0 list-none p-0">
          {state.entries.map((entry) => {
            const chosen = entry.id === selectedId;
            const chips = entryChips(entry).slice(0, 4);
            return (
              <li
                key={entry.id}
                data-voice-id={entry.id}
                className="flex items-center gap-1.5 border-border-subtle pr-2 not-first:border-t"
              >
                <button
                  type="button"
                  aria-pressed={chosen}
                  aria-label={t("voice.catalog.choose", { name: entry.name })}
                  onClick={() => onSelect(presetVoiceOf(entry, language))}
                  className={cn(
                    "grid min-w-0 flex-1 grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 px-3 py-1.5 text-left",
                    "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    chosen ? "bg-surface-2" : "hover:bg-surface-1",
                  )}
                >
                  <span
                    className="mt-0.5 flex size-3.5 items-center justify-center text-accent"
                    aria-hidden
                  >
                    {chosen && <Check size={12} weight="bold" />}
                  </span>
                  <span className="grid min-w-0 gap-px">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-4 text-fg">
                      <span className="truncate">{entry.name}</span>
                      {entry.kind !== "prebuilt" && (
                        <Badge size="sm">{t(`voice.kind.${entry.kind}`)}</Badge>
                      )}
                    </span>
                    {(chips.length > 0 || entry.description) && (
                      <span className="truncate text-xs leading-[14px] text-fg-3">
                        {[...chips, entry.description ?? ""].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                </button>
                {control.preview === "audio_url" && entry.previewUrl !== null && (
                  <VoicePlayButton
                    soundKey={`catalog:${providerId}:${entry.id}`}
                    label={t("voice.catalog.demo", { name: entry.name })}
                    source={() => (entry.previewUrl === null ? null : { url: entry.previewUrl })}
                    size="xs"
                  />
                )}
              </li>
            );
          })}
        </ul>
        {state.loading && (
          <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-fg-3">
            <Spinner size="sm" />
            {t("voice.catalog.loading")}
          </div>
        )}
        {!state.loading && state.nextPageToken !== null && (
          <div className="border-t border-border-subtle px-2 py-1.5">
            <Button size="xs" variant="ghost" onClick={() => void more()}>
              {t("voice.catalog.more")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
