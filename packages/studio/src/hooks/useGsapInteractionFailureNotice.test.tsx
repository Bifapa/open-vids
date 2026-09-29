// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { mountReactHarness } from "./domSelectionTestHarness";
import { GsapEditBlockedError } from "./gsapEditOutcome";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { useGsapInteractionFailureNotice } from "./useGsapInteractionFailureNotice";

function mountFailureNotice(showToast: Mock) {
  let report!: (error: unknown) => void;
  function Harness() {
    report = useGsapInteractionFailureNotice(showToast);
    return null;
  }
  const root = mountReactHarness(<Harness />);
  return { report, root };
}

describe("useGsapInteractionFailureNotice", () => {
  it("toasts the blocked-edit message for an expected edit block", () => {
    const showToast = vi.fn();
    const { report, root } = mountFailureNotice(showToast);

    act(() => report(new GsapEditBlockedError("unroll-required")));

    expect(showToast).toHaveBeenCalledWith(
      "This motion comes from a helper or loop. Choose Unroll to edit it explicitly.",
      "error",
    );
    act(() => root.unmount());
  });

  it("toasts a generic failure for unexpected persistence errors", () => {
    const showToast = vi.fn();
    const { report, root } = mountFailureNotice(showToast);

    act(() => report(new Error("network dropped")));

    expect(showToast).toHaveBeenCalledWith("Failed to save animated edit.", "error");
    act(() => root.unmount());
  });
});
