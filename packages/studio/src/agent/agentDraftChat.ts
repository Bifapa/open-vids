import {
  SPECIALIST_IDS,
  type AgentSettings,
  type ChatSummary,
  type CreateChatRequest,
  type SpecialistOverrides,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";

/** What the composer's chips chose in the new-chat draft, applied when its first message creates the chat. */
export type DraftChoices = Omit<UpdateChatRequest, "title" | "activeMode">;

/** A chip's edit applied to the draft's choices, the way the server would apply it to a chat. */
export function mergeDraftChoices(choices: DraftChoices, request: UpdateChatRequest): DraftChoices {
  const next: DraftChoices = { ...choices };
  if (request.model !== undefined) next.model = request.model;
  if (request.thinking !== undefined) next.thinking = request.thinking;
  if (request.enabledAgents !== undefined) next.enabledAgents = [...request.enabledAgents];
  if (request.intent !== undefined) next.intent = request.intent;
  if (request.executionQuality !== undefined) next.executionQuality = request.executionQuality;
  if (request.agentOverrides) {
    next.agentOverrides = { ...choices.agentOverrides, ...request.agentOverrides };
  }
  return next;
}

/** The overrides a new chat would hold: a null (back to the default) is simply none. */
function overridesOf(choices: DraftChoices): SpecialistOverrides {
  const overrides: SpecialistOverrides = {};
  for (const id of SPECIALIST_IDS) {
    const config = choices.agentOverrides?.[id];
    if (config) overrides[id] = config;
  }
  return overrides;
}

/**
 * The draft as the chips see it: a chat that does not exist yet, starting where a new chat would (the
 * specialists enabled by default, Default model and effort, Edit, the global Execution Quality), plus the choices.
 */
export function draftChatSummary(
  choices: DraftChoices,
  settings: Pick<AgentSettings, "specialists"> | null,
): ChatSummary {
  return {
    id: "",
    projectId: "",
    title: "New chat",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    lastTaskSummary: null,
    activeMode: "normal",
    intent: choices.intent ?? "edit",
    mainAgentModel: choices.model ?? null,
    thinking: choices.thinking ?? null,
    enabledAgents:
      choices.enabledAgents ??
      SPECIALIST_IDS.filter((id) => settings?.specialists[id].enabledByDefault ?? true),
    agentOverrides: overridesOf(choices),
    executionQuality: choices.executionQuality ?? null,
  };
}

/**
 * How the draft becomes a chat: model and thinking travel with the create; the rest is one update right after,
 * before the first turn starts. `update` is null when the chips changed nothing else.
 */
export function draftCreation(choices: DraftChoices): {
  create: CreateChatRequest;
  update: UpdateChatRequest | null;
} {
  const create: CreateChatRequest = {
    ...(choices.model !== undefined && { model: choices.model }),
    ...(choices.thinking !== undefined && { thinking: choices.thinking }),
  };
  const overrides = overridesOf(choices);
  const update: UpdateChatRequest = {
    ...(choices.enabledAgents !== undefined && { enabledAgents: choices.enabledAgents }),
    ...(Object.keys(overrides).length > 0 && { agentOverrides: overrides }),
    ...(choices.intent !== undefined && { intent: choices.intent }),
    ...(choices.executionQuality !== undefined && { executionQuality: choices.executionQuality }),
  };
  return { create, update: Object.keys(update).length > 0 ? update : null };
}
