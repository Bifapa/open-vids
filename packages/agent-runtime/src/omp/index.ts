import type { AgentBackend } from "../backend.ts";
import { createBackend, type ProviderKeySource } from "./backend.ts";

export type { ProviderKeySource };

export function createOmpBackend(options?: {
  agentDir?: string;
  providerKeys?: ProviderKeySource;
  authDbPath?: string;
}): AgentBackend {
  return createBackend(options);
}
