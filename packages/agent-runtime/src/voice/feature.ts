/**
 * Whether Voiceover is on in this runtime. The desktop shell sets `OPENVIDS_BETA_FEATURES=1|0` from its release channel
 * on the Studio sidecar, which the runtime inherits; the feature is on only for an explicit `1` (the cloud connectors
 * are not verified against live provider APIs yet). Off, the runtime has no voice host: the agents get no voice tools
 * and their prompts say nothing about voiceover.
 */
export function voiceFeatureEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.OPENVIDS_BETA_FEATURES === "1";
}
