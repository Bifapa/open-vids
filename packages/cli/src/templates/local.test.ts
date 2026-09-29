import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLocalTemplate, listLocalTemplates } from "./local.js";

describe("local templates", () => {
  it("lists the bundled examples without touching the network", async () => {
    const templates = await listLocalTemplates();
    const ids = templates.map((t) => t.id);
    expect(ids).toContain("warm-grain");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("installs a local example offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-template-"));
    try {
      await fetchLocalTemplate("warm-grain", dir);
      expect(existsSync(join(dir, "index.html"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error for an unknown example", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-template-"));
    try {
      await expect(fetchLocalTemplate("no-such-example", dir)).rejects.toThrow(/not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
