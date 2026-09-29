import type { AgentModelInfo } from "@hyperframes/agent-protocol";

export type ModelRow =
  | { kind: "default" }
  | { kind: "group"; provider: string; count: number }
  | { kind: "model"; model: AgentModelInfo };

/** True when every whitespace-separated token of `query` appears in the model's name, id or provider. */
export function modelMatches(model: AgentModelInfo, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${model.name} ${model.modelId} ${model.provider}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * The picker's flat row list: a "use default" row first (only when not searching), then models
 * grouped by provider, providers and models alphabetical. Flat so the list can be virtualized.
 */
export function buildModelRows(models: readonly AgentModelInfo[], query: string): ModelRow[] {
  const byProvider = new Map<string, AgentModelInfo[]>();
  for (const model of models) {
    if (!modelMatches(model, query)) continue;
    const group = byProvider.get(model.provider);
    if (group) group.push(model);
    else byProvider.set(model.provider, [model]);
  }
  const rows: ModelRow[] = query.trim() === "" ? [{ kind: "default" }] : [];
  const providers = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const group = (byProvider.get(provider) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    rows.push({ kind: "group", provider, count: group.length });
    for (const model of group) rows.push({ kind: "model", model });
  }
  return rows;
}
