// @vitest-environment happy-dom

/**
 * The create dialog when the lists it offers arrive after it opened: the project's videos (the file tree loads
 * asynchronously) and the host's other projects (asked for only once the dialog is open). What is picked is the first
 * entry on offer until the user picks another, so "Create" is never stuck on an empty pick.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignTurnSpec } from "../agent/designTurn";
import { CreateDesignDialog } from "./CreateDesignDialog";
import type { DesignHostCapabilities } from "./designCreate";
import { pressAndSettle, settle } from "./designDom.testHelpers";

const NONE: DesignHostCapabilities = { externalProjects: null };

interface Props {
  initialSource: "scratch" | "video";
  videos: readonly string[];
  videosLoaded: boolean;
  capabilities: DesignHostCapabilities;
}

let mounted: { root: Root; host: HTMLElement } | null = null;
const onStart = vi.fn(async (_spec: DesignTurnSpec) => ({ ok: true as const }));

function render(props: Props): void {
  const element = (
    <CreateDesignDialog {...props} blocker={null} onStart={onStart} onClose={() => {}} />
  );
  if (!mounted) {
    const host = document.createElement("div");
    document.body.append(host);
    mounted = { root: createRoot(host), host };
  }
  const { root } = mounted;
  act(() => root.render(element));
}

afterEach(() => {
  onStart.mockClear();
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const start = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="design-create-start"]');
const radio = (value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="design-source"][value="${value}"]`);

describe("the video list arriving late", () => {
  it("reads 'reading the files' until the tree has loaded, then picks the first video on its own", async () => {
    render({ initialSource: "video", videos: [], videosLoaded: false, capabilities: NONE });
    expect(dialog()?.textContent).toContain("Reading the project's files…");
    expect(dialog()?.textContent).not.toContain("no videos yet");
    expect(start()?.disabled).toBe(true);

    render({
      initialSource: "video",
      videos: ["assets/a.mp4", "assets/b.mov"],
      videosLoaded: true,
      capabilities: NONE,
    });
    await settle();
    expect(dialog()?.textContent).not.toContain("Reading the project's files…");
    expect(start()?.disabled).toBe(false);

    await pressAndSettle(start());
    expect(onStart).toHaveBeenCalledExactlyOnceWith({
      action: "create",
      source: "video",
      video: "assets/a.mp4",
      notes: undefined,
    });
  });

  it("says there is no video only once the tree is known to hold none", async () => {
    render({ initialSource: "video", videos: [], videosLoaded: true, capabilities: NONE });
    expect(dialog()?.textContent).toContain("This project has no videos yet");
    expect(dialog()?.textContent).not.toContain("Reading the project's files…");
    expect(start()?.disabled).toBe(true);
  });

  it("falls back to the first video when the one that was picked is gone from the list", async () => {
    render({
      initialSource: "video",
      videos: ["assets/a.mp4", "assets/b.mov"],
      videosLoaded: true,
      capabilities: NONE,
    });
    render({
      initialSource: "video",
      videos: ["assets/c.mp4"],
      videosLoaded: true,
      capabilities: NONE,
    });
    await pressAndSettle(start());
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ video: "assets/c.mp4" }));
  });
});

describe("the other projects arriving late", () => {
  it("offers 'from another project' once the host lists them, with the first project already chosen", async () => {
    render({ initialSource: "scratch", videos: [], videosLoaded: true, capabilities: NONE });
    expect(radio("external_project")).toBeNull();

    render({
      initialSource: "scratch",
      videos: [],
      videosLoaded: true,
      capabilities: {
        externalProjects: [
          { key: "k-1", name: "Summer trip" },
          { key: "k-2", name: "Winter trip" },
        ],
      },
    });
    await settle();
    await pressAndSettle(radio("external_project"));

    // Nothing was picked by hand: the first project is the one on offer, and Start is not stuck.
    expect(start()?.disabled).toBe(false);
    await pressAndSettle(start());
    expect(onStart).toHaveBeenCalledExactlyOnceWith({
      action: "create",
      source: "external_project",
      projectKey: "k-1",
      projectName: "Summer trip",
      notes: undefined,
    });
  });
});
