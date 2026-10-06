import { Info, WarningCircle } from "@phosphor-icons/react";
import type { VoiceProviderInfo, VoiceProviderNote } from "@hyperframes/agent-protocol";
import { useTranslation } from "../i18n";
import { ExternalLink } from "../research/researchUi";

const GEMINI_TERMS_URL = "https://ai.google.dev/gemini-api/terms";

function FreeTierNote() {
  const { t } = useTranslation();
  return (
    <div
      data-voice-note="free_tier_terms"
      className="grid gap-1 rounded-sm bg-warning-soft px-2 py-1.5 text-xs leading-[15px] text-fg-2"
    >
      <p className="m-0 flex items-start gap-1.5">
        <WarningCircle
          aria-hidden
          size={12}
          weight="fill"
          className="mt-px shrink-0 text-warning"
        />
        <span className="min-w-0 [text-wrap:pretty]">{t("voice.note.freeTier.data")}</span>
      </p>
      <ul className="m-0 grid gap-0.5 pl-[18px]">
        <li>{t("voice.note.freeTier.limits")}</li>
        <li>{t("voice.note.freeTier.region")}</li>
      </ul>
      <p className="m-0 pl-[18px]">
        <ExternalLink href={GEMINI_TERMS_URL}>{t("voice.note.freeTier.link")}</ExternalLink>
      </p>
    </div>
  );
}

function CatalogNote() {
  const { t } = useTranslation();
  return (
    <p
      data-voice-note="catalog_needs_google_key"
      className="m-0 flex items-start gap-1.5 rounded-sm bg-surface-1 px-2 py-1.5 text-xs leading-[15px] text-fg-2"
    >
      <Info aria-hidden size={12} className="mt-px shrink-0 text-fg-3" />
      <span className="min-w-0 [text-wrap:pretty]">{t("voice.note.catalogNeedsGoogleKey")}</span>
    </p>
  );
}

function NoteOf({ note }: { note: VoiceProviderNote }) {
  switch (note) {
    case "free_tier_terms":
      return <FreeTierNote />;
    case "catalog_needs_google_key":
      return <CatalogNote />;
  }
}

/**
 * What a provider's user should know before using it, as the server reports it (`provider.notes`): the Gemini free
 * tier's terms (Google reads what is sent on it; daily limits; paid services only in the EEA, Switzerland and the
 * UK), and that a Gemini model through OpenRouter has no voice catalog or voice design without a Google key.
 */
export function VoiceProviderNotes({ provider }: { provider: VoiceProviderInfo }) {
  if (provider.notes.length === 0) return null;
  return (
    <div className="grid gap-1.5" data-testid={`voice-notes-${provider.id}`}>
      {provider.notes.map((note) => (
        <NoteOf key={note} note={note} />
      ))}
    </div>
  );
}
