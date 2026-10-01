import type { ProviderInfo } from "@hyperframes/agent-protocol";
import { providerIssue } from "./providerStatus";
import { SettingsLink, SettingsStatus } from "./settingsLayout";
import { useSettingsDialog } from "./settingsStore";

/**
 * What is wrong with the provider a model runs on, and a "Fix" link that opens that provider in Models & Providers
 * (prototype: "Google has an error · Fix"). Nothing for a connected provider or one the runtime has not listed.
 */
export function ProviderFix({ provider }: { provider: ProviderInfo | undefined }) {
  const issue = provider ? providerIssue(provider) : null;
  if (!provider || !issue) return null;
  return (
    <SettingsStatus tone="warning" wrap>
      <span>
        {issue}{" "}
        <span className="whitespace-nowrap">
          ·{" "}
          <SettingsLink onClick={() => useSettingsDialog.getState().showProvider(provider.id)}>
            Fix
          </SettingsLink>
        </span>
      </span>
    </SettingsStatus>
  );
}
