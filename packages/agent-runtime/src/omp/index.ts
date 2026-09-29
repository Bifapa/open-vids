import type { AgentBackend } from "../backend.ts";
import { createBackend } from "./backend.ts";

export function createOmpBackend(options?: { agentDir?: string }): AgentBackend {
  return createBackend(options);
}
