import type { VoiceCatalogEntry, VoiceModelInfo } from "@hyperframes/agent-protocol";
import { formatNumber, i18n, isTranslationKey, t } from "../i18n";

/** `similarity_boost` → `Similarity boost`: the label of a control id Studio has no wording for. */
export function humanizeId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A BCP-47 language in words, in Studio's language (`ru` → `Russian`); the code itself when it cannot be named. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([i18n.language || "en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function labelFor(prefix: "voice.control." | "voice.filter.", id: string): string {
  const key = `${prefix}${id}`;
  return isTranslationKey(key) ? t(key) : humanizeId(id);
}

/** The name of a control of the setup window (`voice.control.<id>`); a provider's new control still gets a label. */
export function controlLabel(id: string): string {
  return labelFor("voice.control.", id);
}

/** The name of a catalog filter (`voice.filter.<id>`). */
export function filterLabel(id: string): string {
  return labelFor("voice.filter.", id);
}

/** A price in dollars: cents for ordinary sums, four places for the fractions of a cent speech costs. */
export function formatUsd(value: number): string {
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.1 ? 4 : 2,
  });
}

/** "Gemini 3.8 Flash TTS · $0.0135/min": the model, with its list price per minute of speech when it is known. */
export function modelOptionLabel(model: VoiceModelInfo): string {
  return model.usdPerMinute === null
    ? model.name
    : t("voice.model.priced", { name: model.name, price: formatUsd(model.usdPerMinute) });
}

/** A catalog entry's characteristics as short chips: its labels, in the order the provider sent them. */
export function entryChips(entry: VoiceCatalogEntry): string[] {
  return Object.values(entry.labels).filter((value) => value.trim() !== "");
}

/** What an estimate says about its cost: the dollars, or that the provider's rate is not known. */
export function usdOrUnknown(usdCost: number | null): string {
  return usdCost === null ? t("voice.cost.unknown") : formatUsd(usdCost);
}
