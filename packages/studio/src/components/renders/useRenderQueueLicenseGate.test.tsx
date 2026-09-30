// @vitest-environment happy-dom

// Every export goes through startRender (the Renders panel, the header, each composition card), so the license
// check lives there too. It only ever warns: the user can export anyway, and a check that fails or finds nothing
// must leave the export exactly as it was.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExportLicenseCheck } from "@hyperframes/agent-protocol";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { ExportLicenseDialog } from "../../research/ExportLicenseDialog";
import { useExportLicenseGate } from "../../research/exportLicenseGate";
import { sourceEntry } from "../../research/researchTestHarness";
import { settle } from "../../story/storyTestHarness";
import { mountRenderQueue, renderPosts, type MountedQueue } from "./renderQueueTestHarness";
import type * as FfmpegStatusModule from "./useFfmpegStatus";
import { useRenderQueue } from "./useRenderQueue";

// This machine can encode: only the license check decides here.
vi.mock("./useFfmpegStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof FfmpegStatusModule>()),
  useFfmpegStatus: () => ({ status: { ok: true }, checking: false, recheck: vi.fn() }),
}));

const WARNED: ExportLicenseCheck = {
  composition: "intro.html",
  assets: [sourceEntry({ licenseStatus: "unknown", license: "Unknown" })],
  warnings: [
    {
      asset: "assets/research/ocean.mp4",
      status: "unknown",
      license: "Unknown",
      message: "No license was found for this asset",
    },
  ],
  credits: ["“Ocean waves” by Jane Doe, license unknown"],
};

let check: { status: number; body: unknown };
let fetchMock: Mock<typeof fetch>;
let queue: MountedQueue | null = null;
let host: HTMLElement;

beforeEach(() => {
  check = { status: 200, body: { ...WARNED, warnings: [] } };
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/research/export-check")) {
      return new Response(JSON.stringify(check.body), { status: check.status });
    }
    return new Response(JSON.stringify({ jobId: "j1", status: "rendering" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "EventSource",
    class {
      close(): void {}
      addEventListener(): void {}
    },
  );
  host = mountHost(<ExportLicenseDialog />);
});

afterEach(() => {
  act(() => useExportLicenseGate.getState().decide("cancel"));
  queue?.unmount();
  queue = null;
  cleanupMounted();
  vi.unstubAllGlobals();
  useDockLayoutStore.setState({ pendingActivation: null });
});

/**
 * Starts an export of the active composition and lets it run until it waits on the user or finishes. The export's
 * promise comes back wrapped: an async function returning it bare would wait for it.
 */
async function startExport(): Promise<{ started: Promise<void> }> {
  queue = mountRenderQueue(useRenderQueue, "demo", "intro.html");
  let started: Promise<void> = Promise.resolve();
  await act(async () => {
    started = queue?.api().startRender({}) ?? Promise.resolve();
    await settle();
  });
  return { started };
}

const dialog = () => host.querySelector('[data-testid="export-license-dialog"]');

async function choose(label: string, { started }: { started: Promise<void> }) {
  const target = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!target) throw new Error(`no ${label} button`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await started;
  });
}

describe("export license check", () => {
  it("asks about the composition being exported and, with warnings, waits for Export anyway", async () => {
    check = { status: 200, body: WARNED };

    const exporting = await startExport();

    const checked = String(
      fetchMock.mock.calls.find(([url]) => String(url).includes("export-check"))?.[0],
    );
    expect(checked).toBe("/api/projects/demo/research/export-check?composition=intro.html");
    expect(renderPosts(fetchMock)).toHaveLength(0);
    expect(dialog()?.textContent).toContain("assets/research/ocean.mp4");
    expect(dialog()?.textContent).toContain("No license was found for this asset");
    expect(dialog()?.textContent).toContain("“Ocean waves” by Jane Doe, license unknown");

    await choose("Export anyway", exporting);

    expect(renderPosts(fetchMock)).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  it("Review sources opens the Sources panel and does not export; Cancel does not export", async () => {
    check = { status: 200, body: WARNED };

    await choose("Review sources", await startExport());
    expect(renderPosts(fetchMock)).toHaveLength(0);
    expect(useDockLayoutStore.getState().pendingActivation).toBe("sources");

    queue?.unmount();
    await choose("Cancel", await startExport());
    expect(renderPosts(fetchMock)).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  it("exports directly when the check has no warnings", async () => {
    await startExport();

    expect(dialog()).toBeNull();
    expect(renderPosts(fetchMock)).toHaveLength(1);
  });

  it("exports directly when the check fails", async () => {
    check = { status: 500, body: { error: { code: "network", message: "boom" } } };

    await startExport();

    expect(dialog()).toBeNull();
    expect(renderPosts(fetchMock)).toHaveLength(1);
  });
});
