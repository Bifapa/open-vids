import type {
  AssetProvenance,
  LicenseConfidence,
  LicenseStatus,
  ResearchMediaKind,
} from "@hyperframes/agent-protocol";

export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  clear: "Clear",
  attribution: "Attribution",
  restricted: "Restricted",
  unknown: "Unknown",
};

/** What each status asks of the user, for tooltips and the filter. */
export const LICENSE_STATUS_HINTS: Record<LicenseStatus, string> = {
  clear: "Public domain or CC0: free to use",
  attribution: "Free to use with a credit line",
  restricted: "Read the license: it limits how the asset may be used",
  unknown: "No license found: check the source before publishing",
};

/** Chip colours; restricted and unknown are the warned ones. */
export const LICENSE_STATUS_TONES: Record<LicenseStatus, string> = {
  clear: "border-accent/40 bg-accent/10 text-accent",
  attribution: "border-selection/40 bg-selection/10 text-selection",
  restricted: "border-container/40 bg-container/10 text-container",
  unknown: "border-danger/40 bg-danger/10 text-danger",
};

export function isWarnedStatus(status: LicenseStatus): boolean {
  return status === "restricted" || status === "unknown";
}

export const CONFIDENCE_LABELS: Record<LicenseConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  none: "No license information",
};

export const MEDIA_KIND_LABELS: Record<ResearchMediaKind, string> = {
  video: "Video",
  picture: "Pictures",
  audio: "Audio",
};

/** "Research · Claude Haiku 4.5 · turn t-12" / "You": who brought the asset in. */
export function retrievedByLabel(by: AssetProvenance["retrievedBy"]): string {
  if (by.agent === "user") return "You";
  const agent = by.agent.charAt(0).toUpperCase() + by.agent.slice(1);
  return [agent, by.model, by.turnId ? `turn ${by.turnId}` : null].filter(Boolean).join(" · ");
}

/** The host of a URL for a compact link label, or the URL itself when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
