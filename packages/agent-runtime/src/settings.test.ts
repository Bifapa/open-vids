import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_QUALITY, EXECUTION_BUDGETS } from "@hyperframes/agent-protocol";
import { AgentSettingsStore } from "./settings.js";

describe("AgentSettingsStore", () => {
  it("keeps changes made by another runtime on the same machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      const desktop = new AgentSettingsStore(dir);
      const devShell = new AgentSettingsStore(dir);
      await desktop.get();
      await devShell.update({ jev: { enabled: true, provider: "anthropic" } });
      await desktop.update({
        director: { model: { provider: "p", modelId: "m" }, thinking: "low" },
      });
      await devShell.setJevApiKey("sk-shared");

      const settings = await desktop.get();
      expect(settings.jev).toMatchObject({
        enabled: true,
        provider: "anthropic",
        apiKeyConfigured: true,
      });
      expect(settings.director).toEqual({
        model: { provider: "p", modelId: "m" },
        thinking: "low",
      });
      expect(await desktop.jevApiKey()).toBe("sk-shared");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates a settings file from before Execution Quality to the default, keeping its other values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ director: { model: { provider: "p", modelId: "m" }, thinking: "high" } }),
      );
      const store = new AgentSettingsStore(dir);
      const migrated = await store.get();
      expect(migrated.executionQuality).toEqual(DEFAULT_EXECUTION_QUALITY);
      expect(migrated.executionQuality.preset).toBe("balanced");
      expect(migrated.director.thinking).toBe("high");

      // The next write carries it, and another runtime on the same directory reads it back.
      await store.update({
        executionQuality: { preset: "custom", custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 4 } },
      });
      const stored: unknown = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
      expect(stored).toMatchObject({
        director: { thinking: "high" },
        executionQuality: { preset: "custom", custom: { qaPasses: 4, qaMaxFrames: 12 } },
      });
      const other = await new AgentSettingsStore(dir).get();
      expect(other.executionQuality).toEqual({
        preset: "custom",
        custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 4 },
      });
      // An update that does not mention it leaves it alone.
      await store.update({ director: { model: null, thinking: null } });
      expect((await store.get()).executionQuality.custom.qaPasses).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
