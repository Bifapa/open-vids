// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { openRenderFile, renderFileUrl } from "./openRender";

/** The shell marker Rust appends to the Studio URL (see utils/openvidsHost). */
const SHELL_SEARCH = "?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035";

function setLocation(search: string) {
  window.history.replaceState(null, "", `/${search}#project/demo`);
}

describe("renderFileUrl", () => {
  it("builds the project-scoped file URL with the filename escaped", () => {
    expect(renderFileUrl("my project", "render 測試.mp4")).toBe(
      "/api/projects/my%20project/renders/file/render%20%E6%B8%AC%E8%A9%A6.mp4",
    );
  });
});

describe("openRenderFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLocation("");
  });

  it("opens the file URL in a new tab in a plain browser", async () => {
    setLocation("");
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await openRenderFile("demo", "demo.mp4");

    expect(open).toHaveBeenCalledWith("/api/projects/demo/renders/file/demo.mp4", "_blank");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the shell's server to open the render in the OS player", async () => {
    setLocation(SHELL_SEARCH);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const fetchMock = vi.fn(async () => new Response('{"opened":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await openRenderFile("demo", "render 測試.mp4");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/demo/renders/render%20%E6%B8%AC%E8%A9%A6.mp4/open",
      { method: "POST" },
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects when the server could not open the render", async () => {
    setLocation(SHELL_SEARCH);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"no player"}', { status: 500 })),
    );

    await expect(openRenderFile("demo", "demo.mp4")).rejects.toThrow("no player");
  });
});
