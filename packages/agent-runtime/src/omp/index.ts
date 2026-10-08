import type { AgentBackend } from "../backend.ts";
import { createBackend, type ExtendedContextSource, type ProviderKeySource } from "./backend.ts";

export type { ExtendedContextSource, ProviderKeySource };

export function createOmpBackend(options?: {
  agentDir?: string;
  providerKeys?: ProviderKeySource;
  extendedContext?: ExtendedContextSource;
  authDbPath?: string;
}): AgentBackend {
  return createBackend(options);
}
