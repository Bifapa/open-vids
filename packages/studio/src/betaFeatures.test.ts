import { describe, expect, it } from "vitest";
import {
  BETA_FEATURES,
  OPENVIDS_CHANNEL_PARAM,
  betaFeaturesEnabled,
  isBetaFeatureEnabled,
} from "./betaFeatures";

describe("beta feature flags", () => {
  it("are all off unless the desktop says the build is a beta", () => {
    for (const search of [
      "",
      "?openvidsTheme=dark",
      `?${OPENVIDS_CHANNEL_PARAM}=stable`,
      `?${OPENVIDS_CHANNEL_PARAM}=`,
      `?${OPENVIDS_CHANNEL_PARAM}=BETA`,
      `?${OPENVIDS_CHANNEL_PARAM}=beta2`,
    ]) {
      expect(betaFeaturesEnabled(search), search).toBe(false);
      for (const feature of BETA_FEATURES) {
        expect(isBetaFeatureEnabled(feature, search), `${feature} ${search}`).toBe(false);
      }
    }
  });

  it("are all on in a beta build, whatever else the URL carries", () => {
    const search = `?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&${OPENVIDS_CHANNEL_PARAM}=beta&openvidsFrame=custom`;
    expect(betaFeaturesEnabled(search)).toBe(true);
    for (const feature of BETA_FEATURES) {
      expect(isBetaFeatureEnabled(feature, search), feature).toBe(true);
    }
  });

  it("list the staged features once each", () => {
    expect([...BETA_FEATURES].sort()).toEqual([
      "designSystems",
      "projectMentions",
      "projectTabs",
      "voiceover",
    ]);
    expect(new Set(BETA_FEATURES).size).toBe(BETA_FEATURES.length);
  });
});
