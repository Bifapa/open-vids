import { describe, expect, it } from "vitest";
import { mergeServerRenders, readServerRenders } from "./renderHistory";
import type { RenderJob } from "./useRenderQueue";

const row = (overrides: Partial<RenderJob> & Pick<RenderJob, "id">): RenderJob => ({
  status: "complete",
  progress: 100,
  filename: `${overrides.id}.mp4`,
  createdAt: 1,
  ...overrides,
});

describe("readServerRenders", () => {
  it("keeps well-formed entries and reads anything else as an empty history", () => {
    const good = { id: "a", filename: "a.mp4", createdAt: 3, size: 9, status: "complete" };
    expect(readServerRenders({ renders: [good, { id: 7 }, null, "x"] })).toEqual([good]);
    expect(readServerRenders({ renders: "nope" })).toEqual([]);
    expect(readServerRenders(null)).toEqual([]);
  });
});

describe("mergeServerRenders", () => {
  const history = [
    { id: "kept", filename: "kept.mp4", createdAt: 2, status: "complete" },
    { id: "hidden", filename: "hidden.mp4", createdAt: 3, status: "complete" },
    { id: "bad", filename: "bad.mp4", createdAt: 4, status: "failed" },
  ];

  it("adds history rows the session has none for, except the ones the user hid", () => {
    const merged = mergeServerRenders([row({ id: "mine" })], history, new Set(["hidden"]));
    expect(merged.map((job) => [job.id, job.status])).toEqual([
      ["mine", "complete"],
      ["kept", "complete"],
      ["bad", "failed"],
    ]);
  });

  it("replaces a row that only guessed the render failed when the server says it finished", () => {
    const guessed = row({ id: "kept", status: "failed", progress: 40, connectionLost: true });
    const [merged] = mergeServerRenders([guessed], history, new Set());
    expect(merged).toMatchObject({ id: "kept", status: "complete", progress: 100 });
    expect(merged?.connectionLost).toBeUndefined();
  });

  it("keeps a guessed failure the server also records as failed", () => {
    const guessed = row({ id: "bad", status: "failed", connectionLost: true, error: "lost" });
    expect(mergeServerRenders([guessed], history, new Set())[0]).toBe(guessed);
  });

  it("never overwrites a row whose outcome the progress stream reported itself", () => {
    const failed = row({ id: "kept", status: "failed", error: "encoder crashed" });
    const rendering = row({ id: "bad", status: "rendering", progress: 10 });
    const merged = mergeServerRenders([failed, rendering], history, new Set());
    expect(merged[0]).toBe(failed);
    expect(merged[1]).toBe(rendering);
  });
});
