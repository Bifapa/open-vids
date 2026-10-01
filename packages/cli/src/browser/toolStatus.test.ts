import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectToolStatus, ffVersionNumber } from "./preflight.js";
import * as manager from "./manager.js";

describe("ffVersionNumber", () => {
  it("reads the number out of a version banner", () => {
    expect(
      ffVersionNumber("ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers"),
    ).toBe("9.0.2");
    expect(ffVersionNumber("ffprobe version N-126899-gd975849594-tessus Copyright")).toBe(
      "N-126899-gd975849594-tessus",
    );
    expect(ffVersionNumber("something else")).toBeUndefined();
  });
});

describe("collectToolStatus", () => {
  const saved = {
    ffmpeg: process.env.HYPERFRAMES_FFMPEG_PATH,
    ffprobe: process.env.HYPERFRAMES_FFPROBE_PATH,
  };
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openvids-toolstatus-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["HYPERFRAMES_FFMPEG_PATH", saved.ffmpeg],
      ["HYPERFRAMES_FFPROBE_PATH", saved.ffprobe],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function tool(name: string, banner: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${banner}"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("reports found tools with path and version, and the ready Chrome", async () => {
    const ffmpeg = tool("ffmpeg", "ffmpeg version 9.0.2 Copyright");
    process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
    process.env.HYPERFRAMES_FFPROBE_PATH = tool("ffprobe", "ffprobe version 9.0.2 Copyright");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue({
      executablePath: "/cache/chrome-headless-shell",
      source: "cache",
    });
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue(undefined);
    const report = await collectToolStatus();
    expect(report.ffmpeg).toEqual({ found: true, path: ffmpeg, version: "9.0.2" });
    expect(report.ffprobe.version).toBe("9.0.2");
    expect(report.chrome).toEqual({
      found: true,
      path: "/cache/chrome-headless-shell",
      source: "cache",
      version: manager.managedChromeVersion(),
    });
  });

  it("reports missing tools as not found, and names a system Chrome that rendering does not use", async () => {
    process.env.HYPERFRAMES_FFMPEG_PATH = join(dir, "missing-ffmpeg");
    process.env.HYPERFRAMES_FFPROBE_PATH = join(dir, "missing-ffprobe");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue(undefined);
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      source: "system",
    });
    const report = await collectToolStatus();
    expect(report.ffmpeg).toEqual({ found: false });
    expect(report.ffprobe).toEqual({ found: false });
    expect(report.chrome).toEqual({
      found: false,
      systemPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("does not call a file that fails to run found", async () => {
    const path = join(dir, "ffmpeg");
    writeFileSync(path, "#!/bin/sh\nexit 3\n");
    chmodSync(path, 0o755);
    process.env.HYPERFRAMES_FFMPEG_PATH = path;
    process.env.HYPERFRAMES_FFPROBE_PATH = join(dir, "missing");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue(undefined);
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue(undefined);
    expect((await collectToolStatus()).ffmpeg).toEqual({ found: false, path });
  });
});
