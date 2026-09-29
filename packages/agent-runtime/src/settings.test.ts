import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
