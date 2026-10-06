/**
 * Whether Design Systems is on in this runtime. The desktop shell sets `OPENVIDS_BETA_FEATURES=1|0` from its release
 * channel on the Studio sidecar, which the runtime inherits; the feature is on only for an explicit `1`. Off, the
 * runtime has no design host: a design action is refused, the agents get no design tools and their prompts say nothing
 * about design systems.
 */
export function designFeatureEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.OPENVIDS_BETA_FEATURES === "1";
}
