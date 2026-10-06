// The OPENVIDS_BETA_FEATURES value of the dev Studio server. In production the shell decides (`channel.rs`:
// `beta_features_enabled`, then `env_value`) and sets exactly `1` or `0` on the sidecar; `desktop:dev` has no
// sidecar, the Vite server is started here, and a dev build counts as beta, so it is on unless the user forced it
// off. Spellings the shell accepts (`true`, `yes`, `false`, `no`) are normalised, because the Studio server and the
// agent runtime read only `1` as on.

/** @param {string | undefined} value the user's own OPENVIDS_BETA_FEATURES */
export function devBetaFeatures(value) {
  switch (value?.trim()) {
    case "0":
    case "false":
    case "no":
      return "0";
    default:
      return "1";
  }
}
