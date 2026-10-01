import { useCallback, useEffect, useState } from "react";
import type { AssetSearchPolicy } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import type { ResearchClient } from "./researchClient";

export interface AssetSearchPolicyState {
  policy: AssetSearchPolicy | null;
  loading: boolean;
  /** The last failure, as the server worded it; shown inline until the next action or dismissed. */
  error: string | null;
  /** Which change is on its way (a source id, `mode`, `add`, `restore`), so its control can wait. */
  pending: string | null;
  reload(): Promise<void>;
  /**
   * Runs one policy change (the server's answer is the new policy). Resolves to the failure message, or null when
   * the server accepted it; `inline` changes leave the message to the caller (the add form shows it by its fields).
   */
  change(
    key: string,
    action: (client: ResearchClient) => Promise<AssetSearchPolicy>,
    options?: { inline?: boolean },
  ): Promise<string | null>;
  dismissError(): void;
}

/** The global Asset Search policy for the Sources panel: loaded when the panel shows it, changed one request at a time. */
export function useAssetSearchPolicy(client: ResearchClient): AssetSearchPolicyState {
  const [policy, setPolicy] = useState<AssetSearchPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPolicy(await client.policy());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("research.error.policyLoad"));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const change = useCallback(
    async (
      key: string,
      action: (client: ResearchClient) => Promise<AssetSearchPolicy>,
      options?: { inline?: boolean },
    ) => {
      setPending(key);
      setError(null);
      try {
        setPolicy(await action(client));
        return null;
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : t("research.error.notSaved");
        if (!options?.inline) setError(message);
        return message;
      } finally {
        setPending(null);
      }
    },
    [client],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { policy, loading, error, pending, reload, change, dismissError };
}
