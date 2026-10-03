import {
  PERMISSION_ACTIONS,
  PERMISSION_KINDS,
  PERMISSION_STATES,
  SPECIALIST_IDS,
  isRecord,
  type AnswerPermissionResponse,
  type AssistantPart,
  type PermissionKind,
  type PermissionPart,
  type PermissionRequest,
  type PermissionAction,
  type PermissionState,
  type AgentId,
} from "@hyperframes/agent-protocol";

const AGENT_IDS: readonly string[] = ["director", ...SPECIALIST_IDS, "jev"];

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_IDS.includes(value);
}

function isOneOf<T extends string>(known: readonly T[], value: unknown): value is T {
  return typeof value === "string" && known.some((item) => item === value);
}

/**
 * A permission request as the card reads it. The card dereferences `kind`, `action` and `state` as lookup keys, so
 * a request the runtime worded differently (a newer runtime, a damaged log) is dropped instead of crashing the chat.
 */
export function isPermissionRequest(value: unknown): value is PermissionRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isOneOf<PermissionKind>(PERMISSION_KINDS, value.kind) &&
    isOneOf<PermissionAction>(PERMISSION_ACTIONS, value.action) &&
    (value.site === null || typeof value.site === "string") &&
    isAgentId(value.agent) &&
    isOneOf<PermissionState>(PERMISSION_STATES, value.state) &&
    typeof value.requestedAt === "number"
  );
}

/** A message part that is a well-formed permission card. */
export function isPermissionPart(part: AssistantPart): part is PermissionPart {
  return part.type === "permission" && isPermissionRequest(part.permission);
}

export function isAnswerPermissionResponse(value: unknown): value is AnswerPermissionResponse {
  return isRecord(value) && isPermissionRequest(value.permission);
}
