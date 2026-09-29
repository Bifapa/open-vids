import { describe, expect, it } from "vitest";
import { localRegistryRoot } from "./registry/local.js";

describe("the CLI test run", () => {
  it("resolves the local registry tree without touching the network", async () => {
    const root = localRegistryRoot();
    expect(root).not.toBeNull();
  });
});
