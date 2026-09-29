import { describe, expect, it } from "vitest";
import type { AgentModelInfo } from "@hyperframes/agent-protocol";
import { buildModelRows } from "./modelRows";
import { formatDuration, relativeTime } from "./relativeTime";

const model = (provider: string, modelId: string, name: string): AgentModelInfo => ({
  provider,
  modelId,
  name,
  reasoning: false,
  efforts: [],
});

const MODELS = [
  model("openai", "gpt-mini", "GPT Mini"),
  model("anthropic", "sonnet", "Sonnet"),
  model("anthropic", "haiku", "Haiku"),
];

describe("buildModelRows", () => {
  it("offers 'default' first, then providers alphabetically with their models alphabetically", () => {
    const rows = buildModelRows(MODELS, "");
    expect(rows.map((row) => (row.kind === "model" ? row.model.name : row.kind))).toEqual([
      "default",
      "group",
      "Haiku",
      "Sonnet",
      "group",
      "GPT Mini",
    ]);
    expect(rows[1]).toEqual({ kind: "group", provider: "anthropic", count: 2 });
  });

  it("filters across name, id and provider, drops empty groups and the default row", () => {
    const rows = buildModelRows(MODELS, "anth son");
    expect(rows).toEqual([
      { kind: "group", provider: "anthropic", count: 1 },
      { kind: "model", model: MODELS[1] },
    ]);
    expect(buildModelRows(MODELS, "zzz")).toEqual([]);
  });

  it("copes with a catalog of the real size", () => {
    const many = Array.from({ length: 1200 }, (_, index) =>
      model(`p${index % 40}`, `m${index}`, `Model ${index}`),
    );
    expect(buildModelRows(many, "").length).toBe(1200 + 40 + 1);
    const [group, only] = buildModelRows(many, "model 1199");
    expect(group).toEqual({ kind: "group", provider: "p39", count: 1 });
    expect(only).toMatchObject({ kind: "model", model: { modelId: "m1199" } });
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  it("steps from just now to days", () => {
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("never goes negative when the server clock is ahead", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("formatDuration", () => {
  it("reads as seconds, then minutes", () => {
    expect(formatDuration(400)).toBe("1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 05s");
  });
});
