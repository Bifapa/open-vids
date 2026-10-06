import { isBetaFeatureEnabled } from "../betaFeatures";
import { useVoiceUi } from "./voiceUiStore";
import { VoiceSetupDialog } from "./VoiceSetupDialog";

/**
 * The voice surface's window, mounted once beside Settings and the design dialogs. A chat card or Settings asks for
 * it through `useVoiceUi().openSetup(...)`; nothing renders with the beta flag off.
 */
export function VoiceHost() {
  if (!isBetaFeatureEnabled("voiceover")) return null;
  return <VoiceHostBody />;
}

function VoiceHostBody() {
  const setup = useVoiceUi((state) => state.setup);
  const close = useVoiceUi((state) => state.closeSetup);
  if (setup === null) return null;
  return <VoiceSetupDialog request={setup} onClose={close} />;
}
