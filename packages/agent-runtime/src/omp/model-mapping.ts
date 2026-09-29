import type {
  AgentModelCatalog,
  AgentModelInfo,
  ModelSelection,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { THINKING_EFFORTS } from "@hyperframes/agent-protocol";

export interface ModelCatalogSource extends ModelSelection {
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  supportedEfforts: readonly unknown[];
}

export interface ParsedModelRole {
  model: ModelSelection;
  thinking: ThinkingEffort | null;
}

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  if (typeof value !== "string") return false;
  return THINKING_EFFORTS.some((effort) => effort === value);
}

export function mapSupportedEfforts(efforts: readonly unknown[]): ThinkingEffort[] {
  return efforts.filter(
    (effort): effort is ThinkingEffort => isThinkingEffort(effort) && effort !== "off",
  );
}

export function mapModelInfo(source: ModelCatalogSource): AgentModelInfo {
  return {
    provider: source.provider,
    modelId: source.modelId,
    name: source.name,
    reasoning: source.reasoning,
    efforts: mapSupportedEfforts(source.supportedEfforts),
    ...(typeof source.contextWindow === "number" && Number.isFinite(source.contextWindow)
      ? { contextWindow: source.contextWindow }
      : {}),
  };
}

export function parseModelRole(value: string | undefined): ParsedModelRole | null {
  if (!value) return null;
  const selector = value.trim();
  const slashIndex = selector.indexOf("/");
  if (slashIndex < 1 || slashIndex === selector.length - 1) return null;

  const provider = selector.slice(0, slashIndex).trim();
  let modelId = selector.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;

  let thinking: ThinkingEffort | null = null;
  const suffixIndex = modelId.lastIndexOf(":");
  if (suffixIndex > 0) {
    const suffix = modelId.slice(suffixIndex + 1);
    if (isThinkingEffort(suffix)) {
      thinking = suffix;
      modelId = modelId.slice(0, suffixIndex);
    }
  }

  if (!modelId) return null;
  return { model: { provider, modelId }, thinking };
}

export function createModelCatalog(
  sources: readonly ModelCatalogSource[],
  defaultRole: string | undefined,
  defaultThinking: ThinkingEffort | null,
): AgentModelCatalog {
  const models = sources.map(mapModelInfo);
  const role = parseModelRole(defaultRole);
  const defaultModel =
    role &&
    models.some(
      (model) => model.provider === role.model.provider && model.modelId === role.model.modelId,
    )
      ? role.model
      : null;

  return {
    models,
    defaultModel,
    defaultThinking: defaultModel ? defaultThinking : null,
  };
}

export function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.provider === right.provider &&
    left.modelId === right.modelId
  );
}
