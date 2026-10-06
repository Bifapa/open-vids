import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, isVoiceProviderId, type VoiceProviderId } from "@hyperframes/agent-protocol";
import defaultPricing from "./pricing.default.json";

export const VOICE_PRICING_FILE = "pricing.json";
const PRICING_SCHEMA = "openvids.voice-pricing/1";

/** Speech runs at about 15 characters per second; the per-minute price of a per-character rate uses it. */
export const SPEECH_CHARS_PER_MINUTE = 900;
/** Input tokens are about a quarter of the characters. */
const CHARS_PER_TOKEN = 4;

/** The price terms of one rate; the cost of a request is the sum of the terms that are present. */
export interface VoicePriceTerms {
  usdPerMinute?: number;
  usdPer1kChars?: number;
  usdPer1MChars?: number;
  usdPer1MInputTokens?: number;
}

export interface VoicePriceRate extends VoicePriceTerms {
  providerId: VoiceProviderId;
  /** An exact model id, or a prefix ending with `*`. */
  model: string;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  /** `YYYY-MM-DD`, exclusive. */
  until?: string;
  source: string;
}

const TERM_FIELDS = [
  "usdPerMinute",
  "usdPer1kChars",
  "usdPer1MChars",
  "usdPer1MInputTokens",
] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseRate(value: unknown): VoicePriceRate | null {
  if (!isRecord(value) || !isVoiceProviderId(value.providerId)) return null;
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  const rate: VoicePriceRate = {
    providerId: value.providerId,
    model: value.model,
    source: typeof value.source === "string" ? value.source : "",
  };
  for (const field of ["from", "until"] as const) {
    const date = value[field];
    if (date === undefined) continue;
    if (typeof date !== "string" || !DATE.test(date)) return null;
    rate[field] = date;
  }
  for (const field of TERM_FIELDS) {
    const term = value[field];
    if (term === undefined) continue;
    if (typeof term !== "number" || !Number.isFinite(term) || term < 0) return null;
    rate[field] = term;
  }
  return rate;
}

function parseRates(document: unknown): VoicePriceRate[] {
  if (!isRecord(document) || document.schema !== PRICING_SCHEMA || !Array.isArray(document.rates))
    return [];
  const rates: VoicePriceRate[] = [];
  for (const entry of document.rates) {
    const rate = parseRate(entry);
    if (rate) rates.push(rate);
  }
  return rates;
}

const DEFAULT_RATES: readonly VoicePriceRate[] = parseRates(defaultPricing);

/** How specific a rate's model pattern is: an exact id beats any prefix, a longer prefix beats a shorter one. */
function specificity(rate: VoicePriceRate, model: string): number {
  if (rate.model === model) return Number.MAX_SAFE_INTEGER;
  if (rate.model.endsWith("*") && model.startsWith(rate.model.slice(0, -1)))
    return rate.model.length;
  return -1;
}

function inWindow(rate: VoicePriceRate, day: string): boolean {
  return (
    (rate.from === undefined || day >= rate.from) && (rate.until === undefined || day < rate.until)
  );
}

/**
 * What speech costs. Rates come from the user's `pricing.json` (first), the price list a provider published for its
 * models (OpenRouter), and the shipped table; the one for the day, with the most specific model, wins. A model with
 * no rate, or whose rate leaves out what the audio costs, has no estimate (`null`), never a guess.
 */
export class VoicePricing {
  private readonly file: string;
  private override: { mtimeMs: number; rates: VoicePriceRate[] } | null = null;
  private readonly listed: VoicePriceRate[] = [];

  constructor(
    dir: string,
    private readonly now: () => number,
  ) {
    this.file = join(dir, VOICE_PRICING_FILE);
  }

  private userRates(): VoicePriceRate[] {
    if (!existsSync(this.file)) return [];
    try {
      const { mtimeMs } = statSync(this.file);
      if (this.override?.mtimeMs !== mtimeMs) {
        const document: unknown = JSON.parse(readFileSync(this.file, "utf-8"));
        this.override = { mtimeMs, rates: parseRates(document) };
      }
      return this.override.rates;
    } catch {
      return [];
    }
  }

  /** Records the price list a provider published for a model (replaces the earlier one). */
  setListed(
    providerId: VoiceProviderId,
    model: string,
    terms: VoicePriceTerms,
    source: string,
  ): void {
    const index = this.listed.findIndex(
      (rate) => rate.providerId === providerId && rate.model === model,
    );
    const rate: VoicePriceRate = { providerId, model, source, ...terms };
    if (index >= 0) this.listed[index] = rate;
    else this.listed.push(rate);
  }

  /** The rate in force on `now` for a model, or null. */
  rateFor(providerId: VoiceProviderId, model: string, now = this.now()): VoicePriceRate | null {
    const day = new Date(now).toISOString().slice(0, 10);
    const sources = [this.userRates(), this.listed, DEFAULT_RATES];
    for (const rates of sources) {
      let best: VoicePriceRate | null = null;
      let bestScore = -1;
      for (const rate of rates) {
        if (rate.providerId !== providerId || !inWindow(rate, day)) continue;
        const score = specificity(rate, model);
        if (score > bestScore) {
          best = rate;
          bestScore = score;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * USD for `chars` of text and `seconds` of speech, or null when the price is unknown or partial (only the input
   * side is published).
   */
  estimateUsd(
    providerId: VoiceProviderId,
    model: string,
    chars: number,
    seconds: number,
    now = this.now(),
  ): number | null {
    const rate = this.rateFor(providerId, model, now);
    if (!rate) return null;
    if (
      rate.usdPerMinute === undefined &&
      rate.usdPer1kChars === undefined &&
      rate.usdPer1MChars === undefined
    )
      return null;
    return (
      ((rate.usdPerMinute ?? 0) * seconds) / 60 +
      ((rate.usdPer1kChars ?? 0) * chars) / 1_000 +
      ((rate.usdPer1MChars ?? 0) * chars) / 1_000_000 +
      ((rate.usdPer1MInputTokens ?? 0) * (chars / CHARS_PER_TOKEN)) / 1_000_000
    );
  }

  /** The list price of a minute of speech for a model listing, or null when unknown. */
  usdPerMinute(providerId: VoiceProviderId, model: string, now = this.now()): number | null {
    return this.estimateUsd(providerId, model, SPEECH_CHARS_PER_MINUTE, 60, now);
  }
}
