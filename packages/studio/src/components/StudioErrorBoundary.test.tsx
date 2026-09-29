// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StudioErrorBoundary } from "./StudioErrorBoundary";

function Boom(): React.ReactElement {
  throw new Error("timeline exploded");
}

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // React logs the caught error itself; the boundary is the thing under test.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
});

const renderCrashed = () =>
  act(() => {
    root.render(
      <StudioErrorBoundary>
        <Boom />
      </StudioErrorBoundary>,
    );
  });

describe("StudioErrorBoundary", () => {
  it("shows the crash screen with the error message and both recovery paths", () => {
    renderCrashed();
    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("timeline exploded");
    expect(container.textContent).toContain("Try again");
    expect(container.textContent).toContain("Reload Studio");
  });
});
