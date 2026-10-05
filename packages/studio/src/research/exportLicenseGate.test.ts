import { afterEach, describe, expect, it } from "vitest";
import type { ExportLicenseCheck } from "@hyperframes/agent-protocol";
import { askExportDecision, useExportLicenseGate } from "./exportLicenseGate";

const WARNED: ExportLicenseCheck = {
  composition: "intro.html",
  assets: [],
  warnings: [
    {
      asset: "assets/research/ocean.mp4",
      status: "unknown",
      license: "Unknown",
      message: "No license was found for this asset",
    },
  ],
  credits: [],
};

const withResolvers = Object.getOwnPropertyDescriptor(Promise, "withResolvers");

afterEach(() => {
  if (withResolvers) Object.defineProperty(Promise, "withResolvers", withResolvers);
  useExportLicenseGate.setState({ pending: null });
});

describe("askExportDecision", () => {
  // The WebKit of macOS 11, the minimum OS, has no Promise.withResolvers: the gate must not need it.
  it("asks and resolves with the decision where Promise.withResolvers does not exist", async () => {
    Reflect.deleteProperty(Promise, "withResolvers");

    const decision = askExportDecision(WARNED);
    expect(useExportLicenseGate.getState().pending).toBe(WARNED);
    useExportLicenseGate.getState().decide("review");

    await expect(decision).resolves.toBe("review");
    expect(useExportLicenseGate.getState().pending).toBeNull();
  });

  it("cancels an unanswered question when a newer one arrives", async () => {
    const first = askExportDecision(WARNED);
    const second = askExportDecision(WARNED);

    await expect(first).resolves.toBe("cancel");
    useExportLicenseGate.getState().decide("export");
    await expect(second).resolves.toBe("export");
  });
});
