import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  effectiveSpecialistConfig,
  type AgentModelCatalog,
  type AgentSettings,
  type ChatSummary,
  type EditorContext,
  type ModelSelection,
  type SpecialistConfig,
  type SpecialistId,
  type TestJevResponse,
} from "@hyperframes/agent-protocol";
import type { AgentBackend } from "../backend.js";
import { errorMessage } from "../errors.js";
import type { JevRuntime, TurnAgentSetup } from "./orchestrator.js";
import { jevInstructions } from "./roles.js";
import { researchTeamLine } from "../research/prompt.js";

const JEV_TEST_TIMEOUT_MS = 60_000;

/**
 * Jev as it can actually run, or null. In API-key mode the stored key is required; with provider sign-in the model
 * must be one the runtime already has credentials for.
 */
export function resolveJev(
  settings: AgentSettings,
  apiKey: string | null,
  catalog: AgentModelCatalog,
): JevRuntime | null {
  const { jev } = settings;
  if (!jev.enabled || !jev.provider || !jev.modelId) return null;
  const model: ModelSelection = { provider: jev.provider, modelId: jev.modelId };
  if (jev.credentials === "api-key") {
    return apiKey
      ? { model, thinking: jev.thinking, credentials: { provider: jev.provider, apiKey } }
      : null;
  }
  const usable = catalog.models.some(
    (candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId,
  );
  return usable ? { model, thinking: jev.thinking } : null;
}

export function resolveTurnSetup(input: {
  chat: ChatSummary;
  settings: AgentSettings;
  jevApiKey: string | null;
  catalog: AgentModelCatalog;
  editorContext?: EditorContext;
}): TurnAgentSetup {
  const { chat, settings, catalog } = input;
  const specialists: Record<SpecialistId, SpecialistConfig> = {
    editor: effectiveSpecialistConfig(chat, settings, "editor"),
    vision: effectiveSpecialistConfig(chat, settings, "vision"),
    motion: effectiveSpecialistConfig(chat, settings, "motion"),
    research: effectiveSpecialistConfig(chat, settings, "research"),
    audio: effectiveSpecialistConfig(chat, settings, "audio"),
  };
  return {
    enabled: SPECIALIST_IDS.filter((id) => chat.enabledAgents.includes(id)),
    specialists,
    jev: resolveJev(settings, input.jevApiKey, catalog),
    catalog,
    ...(input.editorContext && { editorContext: input.editorContext }),
  };
}

const describeModel = (model: ModelSelection | null) =>
  model ? `${model.provider}/${model.modelId}` : "default model";

/** The team roster the Director sees at the top of each turn. */
export function renderTeam(setup: TurnAgentSetup): string {
  const lines: string[] = [];
  if (setup.enabled.length === 0) {
    lines.push("No specialists are enabled in this chat: do the work yourself.");
  } else {
    lines.push("Specialists enabled in this chat (delegate only to these):");
    for (const id of setup.enabled) {
      const config = setup.specialists[id];
      const allowed = config.allowedModels.map(describeModel);
      lines.push(
        `- ${id} (${AGENT_DISPLAY_NAMES[id]}): ${describeModel(config.model)}, thinking ${config.thinking ?? "default"}${
          allowed.length > 0
            ? `; you may also route it to ${allowed.join(", ")}`
            : "; model fixed by the user"
        }`,
      );
    }
    const disabled = SPECIALIST_IDS.filter((id) => !setup.enabled.includes(id));
    if (disabled.length > 0)
      lines.push(
        `Disabled (never delegate): ${disabled.map((id) => AGENT_DISPLAY_NAMES[id]).join(", ")}.`,
      );
  }
  lines.push(researchTeamLine(setup.enabled.includes("research"), setup.research));
  lines.push(
    setup.jev
      ? `Jev fast worker: available (${describeModel(setup.jev.model)}).`
      : "Jev fast worker: not available.",
  );
  return `<team>\n${lines.join("\n")}\n</team>`;
}

/** Runs one tiny prompt on Jev as configured, so the user can check provider, model and key. */
export async function testJev(
  backend: AgentBackend,
  projectDir: string,
  jev: JevRuntime | null,
  now: () => number = Date.now,
): Promise<TestJevResponse> {
  if (!jev) {
    return {
      ok: false,
      message:
        "Jev is not ready: enable it, choose a provider and model, and either save an API key or pick a model you are signed in to.",
    };
  }
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TEST_TIMEOUT_MS);
  let reply = "";
  try {
    const session = await backend.openSession({
      chatId: "jev-test",
      agent: "jev",
      projectDir,
      stateDir: null,
      instructions: jevInstructions(),
      hostTools: [],
      ...(jev.credentials && { credentials: jev.credentials }),
    });
    try {
      const outcome = await session.prompt({
        text: "Connection check: reply with exactly the word ready.",
        model: jev.model,
        thinking: jev.thinking,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text.delta") reply += event.delta;
        },
      });
      if (outcome === "aborted")
        return { ok: false, message: "Jev did not answer within 60 seconds." };
    } finally {
      await session.dispose().catch(() => undefined);
    }
    return { ok: true, model: jev.model, reply: reply.trim(), elapsedMs: now() - startedAt };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Jev failed") };
  } finally {
    clearTimeout(timer);
  }
}
