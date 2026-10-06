import { describe, expect, it } from "vitest";
import { designFeatureEnabled } from "./feature.js";

describe("designFeatureEnabled", () => {
  it("is on only for an explicit OPENVIDS_BETA_FEATURES=1", () => {
    expect(designFeatureEnabled({ OPENVIDS_BETA_FEATURES: "1" })).toBe(true);
    for (const value of [undefined, "0", "", "true", "on", " 1"]) {
      expect(designFeatureEnabled({ OPENVIDS_BETA_FEATURES: value })).toBe(false);
    }
    expect(designFeatureEnabled({})).toBe(false);
  });
});
