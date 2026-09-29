import {
  AGENT_DISPLAY_NAMES,
  THINKING_EFFORTS,
  type AgentModelCatalog,
  type ModelSelection,
  type SpecialistConfig,
  type SpecialistId,
  type ThinkingEffort,
} from "@hyperframes/agent-protocol";

export type RoutingResult =
  | { ok: true; model: ModelSelection | null; thinking: ThinkingEffort | null; routed: boolean }
  | { ok: false; message: string };

export interface RoutingRequest {
  model?: ModelSelection;
  thinking?: ThinkingEffort;
}

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null): boolean =>
  left !== null &&
  right !== null &&
  left.provider === right.provider &&
  left.modelId === right.modelId;

const describe = (model: ModelSelection | null): string =>
  model ? `${model.provider}/${model.modelId}` : "the default model";

/**
 * Applies the user's limits to the model/effort the Director asked for one delegated task:
 * - the model must be the specialist's configured model or one of its `allowedModels`, and usable (authenticated);
 * - thinking may be lowered for the task but never raised above the configured (or, when unset, default) effort.
 * Violations are reported back to the Director instead of being silently corrected.
 */
export function routeDelegation(
  specialist: SpecialistId,
  config: SpecialistConfig,
  request: RoutingRequest,
  catalog: AgentModelCatalog,
): RoutingResult {
  const name = AGENT_DISPLAY_NAMES[specialist];
  let model = config.model;
  let routed = false;
  if (request.model && !sameSelection(request.model, config.model)) {
    const requested = request.model;
    if (!config.allowedModels.some((allowed) => sameSelection(allowed, requested))) {
      const allowed = config.allowedModels.map(describe);
      return {
        ok: false,
        message:
          allowed.length > 0
            ? `${name} may only run on ${describe(config.model)} or: ${allowed.join(", ")}.`
            : `${name} must run on ${describe(config.model)}; the user has not allowed other models for it.`,
      };
    }
    if (!catalog.models.some((available) => sameSelection(available, requested))) {
      return {
        ok: false,
        message: `${describe(requested)} is allowed for ${name} but is not available (no credentials).`,
      };
    }
    model = requested;
    routed = true;
  }

  let thinking = config.thinking;
  if (request.thinking && request.thinking !== config.thinking) {
    const cap = config.thinking ?? catalog.defaultThinking ?? "high";
    if (THINKING_EFFORTS.indexOf(request.thinking) > THINKING_EFFORTS.indexOf(cap)) {
      return {
        ok: false,
        message: `${name}'s thinking effort is limited to ${cap}; you may only lower it.`,
      };
    }
    thinking = request.thinking;
    routed = true;
  }
  return { ok: true, model, thinking, routed };
}

/** Parses the Director's "provider/modelId" model argument. */
export function parseModelArgument(value: string): ModelSelection | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash).trim(), modelId: value.slice(slash + 1).trim() };
}
