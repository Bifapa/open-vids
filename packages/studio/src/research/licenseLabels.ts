import type {
  AssetProvenance,
  LicenseConfidence,
  LicenseStatus,
  ProvenanceMediaKind,
} from "@hyperframes/agent-protocol";
import type { StatusTone } from "../components/ui";
import { AGENT_NAME_KEYS } from "../components/chat/agentLabels";
import { t, type TranslationKey } from "../i18n";

export const LICENSE_STATUS_LABELS = {
  clear: "research.license.status.clear",
  attribution: "research.license.status.attribution",
  restricted: "research.license.status.restricted",
  unknown: "research.license.status.unknown",
} as const satisfies Record<LicenseStatus, TranslationKey>;

/** What each status asks of the user, for tooltips and the filter. */
export const LICENSE_STATUS_HINTS = {
  clear: "research.license.hint.clear",
  attribution: "research.license.hint.attribution",
  restricted: "research.license.hint.restricted",
  unknown: "research.license.hint.unknown",
} as const satisfies Record<LicenseStatus, TranslationKey>;

/** Badge tone per status; restricted and unknown are the warned ones. */
export const LICENSE_STATUS_TONES: Record<LicenseStatus, StatusTone> = {
  clear: "success",
  attribution: "neutral",
  restricted: "warning",
  unknown: "error",
};

/** Group headings in the Sources list, most urgent first. */
export const LICENSE_STATUS_GROUPS: ReadonlyArray<{
  status: LicenseStatus;
  label: TranslationKey;
}> = [
  { status: "unknown", label: "research.license.group.unknown" },
  { status: "restricted", label: "research.license.group.restricted" },
  { status: "attribution", label: "research.license.group.attribution" },
  { status: "clear", label: "research.license.group.clear" },
];

export const CONFIDENCE_LABELS = {
  high: "research.license.confidence.high",
  medium: "research.license.confidence.medium",
  low: "research.license.confidence.low",
  none: "research.license.confidence.none",
} as const satisfies Record<LicenseConfidence, TranslationKey>;

export const MEDIA_KIND_LABELS = {
  video: "research.mediaKind.video",
  picture: "research.mediaKind.picture",
  audio: "research.mediaKind.audio",
  font: "research.mediaKind.font",
} as const satisfies Record<ProvenanceMediaKind, TranslationKey>;

/** "Research · Claude Haiku 4.5 · turn t-12" / "You": who brought the asset in. */
export function retrievedByLabel(by: AssetProvenance["retrievedBy"]): string {
  if (by.agent === "user") return t("research.by.you");
  return [
    t(AGENT_NAME_KEYS[by.agent]),
    by.model,
    by.turnId ? t("research.by.turn", { id: by.turnId }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The host of a URL for a compact link label, or the URL itself when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
