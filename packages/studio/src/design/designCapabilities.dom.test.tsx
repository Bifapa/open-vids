// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrossProjectClient } from "../agent/crossProjectClient";
import { useDesignHostCapabilities, type DesignHostCapabilities } from "./designCreate";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount(client: CrossProjectClient, enabled: boolean): () => DesignHostCapabilities {
  let latest: DesignHostCapabilities | undefined;
  function Probe() {
    latest = useDesignHostCapabilities("p1", enabled, client);
    return null;
  }
  const host = document.createElement("div");
  root = createRoot(host);
  act(() => root?.render(createElement(Probe)));
  return () => {
    if (!latest) throw new Error("not rendered");
    return latest;
  };
}

const settle = () => act(async () => void (await Promise.resolve()));

function clientOf(projects: CrossProjectClient["projects"]): CrossProjectClient {
  return { projects, summary: vi.fn() };
}

describe("useDesignHostCapabilities", () => {
  it("lists the other projects only while the create dialog asks, as plain key + name", async () => {
    const projects = vi.fn(async () => [
      { key: "k-1", name: "Summer trip", openedAt: 5 },
      { key: "k-2", name: "Promo" },
    ]);
    const idle = mount(clientOf(projects), false);
    await settle();
    expect(projects).not.toHaveBeenCalled();
    expect(idle().externalProjects).toBeNull();

    act(() => root?.unmount());
    const open = mount(clientOf(projects), true);
    await settle();
    expect(projects).toHaveBeenCalledWith("p1", expect.any(AbortSignal));
    expect(open().externalProjects).toEqual([
      { key: "k-1", name: "Summer trip" },
      { key: "k-2", name: "Promo" },
    ]);
  });

  it("reports no capability when there is no other project or the host fails", async () => {
    const none = mount(
      clientOf(async () => []),
      true,
    );
    await settle();
    expect(none().externalProjects).toBeNull();

    act(() => root?.unmount());
    const failing = mount(
      clientOf(async () => {
        throw new Error("HTTP 404");
      }),
      true,
    );
    await settle();
    expect(failing().externalProjects).toBeNull();
  });
});
