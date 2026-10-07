import { describe, expect, it } from "vitest";
import { BETA_FEATURES, OPENVIDS_CHANNEL_PARAM, betaFeaturesEnabled } from "./betaFeatures";

describe("beta channel", () => {
  it("is off unless the desktop says the build is a beta", () => {
    for (const search of [
      "",
      "?openvidsTheme=dark",
      `?${OPENVIDS_CHANNEL_PARAM}=stable`,
      `?${OPENVIDS_CHANNEL_PARAM}=`,
      `?${OPENVIDS_CHANNEL_PARAM}=BETA`,
      `?${OPENVIDS_CHANNEL_PARAM}=beta2`,
    ]) {
      expect(betaFeaturesEnabled(search), search).toBe(false);
    }
  });

  it("is on in a beta build, whatever else the URL carries", () => {
    const search = `?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&${OPENVIDS_CHANNEL_PARAM}=beta&openvidsFrame=custom`;
    expect(betaFeaturesEnabled(search)).toBe(true);
  });

  it("stages no feature while every shipped one is on stable", () => {
    expect(BETA_FEATURES).toEqual([]);
  });
});
