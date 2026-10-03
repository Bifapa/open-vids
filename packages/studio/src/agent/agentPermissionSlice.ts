import type { StoreApi } from "zustand/vanilla";
import type { PermissionDecision, PermissionRequest } from "@hyperframes/agent-protocol";
import { announceAssetSearchPolicyChanged } from "../research/policyChanges";
import type { AgentClient } from "./agentClient";
import { describeAgentError, describeAgentFailure } from "./agentErrors";
import type { AgentState } from "./agentStore";

/** How the user's answer to a permission card ended: the request as the runtime now has it, or why it failed. */
export type PermissionAnswer =
  | { ok: true; permission: PermissionRequest }
  | { ok: false; message: string };

/** The permission cards of the open chat. */
export interface AgentPermissionSlice {
  /**
   * Answers a pending permission request of a turn. The chat stream carries the updated part (the source of truth);
   * the answer returned here only ends the card's busy state. A turned-on setting is announced to the Asset Search
   * views. Never rejects.
   */
  answerPermission(
    turnId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<PermissionAnswer>;
}

export interface AgentPermissionSliceDeps {
  client: AgentClient;
  get: StoreApi<AgentState>["getState"];
}

export function createAgentPermissionSlice({
  client,
  get,
}: AgentPermissionSliceDeps): AgentPermissionSlice {
  return {
    async answerPermission(turnId, permissionId, decision) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal") };
      try {
        const { permission } = await client.answerPermission(
          chatId,
          turnId,
          permissionId,
          decision,
        );
        if (permission.state === "enabled") announceAssetSearchPolicyChanged();
        return { ok: true, permission };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },
  };
}
