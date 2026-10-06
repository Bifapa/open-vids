/**
 * Beta features: code on `main` that only a beta build of the desktop turns on (debug builds too, and
 * `OPENVIDS_BETA_FEATURES=1|0` forces it; `apps/desktop/src-tauri/src/channel.rs`). The desktop says so with
 * `openvidsChannel=beta` in Studio's URL; without it (stable builds, a plain browser) every beta feature is off.
 */

/** URL parameter the desktop sets when beta features are on. */
export const OPENVIDS_CHANNEL_PARAM = "openvidsChannel";

/** Every beta feature, by id. A feature leaves this list when it ships on the stable channel. */
export const BETA_FEATURES = ["projectTabs", "projectMentions", "designSystems"] as const;

export type BetaFeatureId = (typeof BETA_FEATURES)[number];

/** Whether the desktop turned beta features on for this page (`search` defaults to the current URL's query). */
export function betaFeaturesEnabled(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(OPENVIDS_CHANNEL_PARAM) === "beta";
}

/** Whether one beta feature is on. Every listed feature follows the channel; the id keeps call sites greppable. */
export function isBetaFeatureEnabled(
  feature: BetaFeatureId,
  search: string = window.location.search,
): boolean {
  return BETA_FEATURES.includes(feature) && betaFeaturesEnabled(search);
}
