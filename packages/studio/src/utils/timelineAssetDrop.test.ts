// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildTimelineFileDropPlacements,
  extendCompositionDurationIfNeeded,
  resolveTimelineAssetCompositionSize,
  setCompositionDurationToContent,
} from "./timelineAssetDrop";

describe("setCompositionDurationToContent", () => {
  const src = (dur: number) =>
    `<div id="root" data-composition-id="c" data-duration="${dur}">x</div>`;

  it("shrinks the root duration to the content end", () => {
    expect(setCompositionDurationToContent(src(20), 8)).toContain('data-duration="8"');
  });

  it("grows the root duration to the content end", () => {
    expect(setCompositionDurationToContent(src(5), 12)).toContain('data-duration="12"');
  });

  it("is a no-op when content end is 0 (empty timeline keeps its declared length)", () => {
    expect(setCompositionDurationToContent(src(12), 0)).toBe(src(12));
  });

  it("is a no-op when already equal", () => {
    expect(setCompositionDurationToContent(src(9), 9)).toBe(src(9));
  });

  // Reviewer round-2 finding #3: attribute-order and single-quote variants that
  // the old order-dependent, double-quotes-only regex silently ignored.
  it("patches when data-duration precedes data-composition-id", () => {
    const source = `<div data-duration="20" data-composition-id="c">x</div>`;
    expect(setCompositionDurationToContent(source, 8)).toBe(
      `<div data-duration="8" data-composition-id="c">x</div>`,
    );
  });

  it("patches single-quoted attributes and keeps the quote style", () => {
    const source = `<div data-composition-id='c' data-duration='20'>x</div>`;
    expect(setCompositionDurationToContent(source, 8)).toBe(
      `<div data-composition-id='c' data-duration='8'>x</div>`,
    );
  });
});

describe("extendCompositionDurationIfNeeded", () => {
  it("grows the root duration when a clip lands past the end", () => {
    const source = `<div data-composition-id="c" data-duration="5">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(
      `<div data-composition-id="c" data-duration="8">x</div>`,
    );
  });

  it("is a no-op when the required end fits within the current duration", () => {
    const source = `<div data-composition-id="c" data-duration="10">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(source);
  });

  it("grows even when the attribute order is swapped and quotes are single", () => {
    const source = `<div data-duration='5' data-composition-id='c'>x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(
      `<div data-duration='8' data-composition-id='c'>x</div>`,
    );
  });

  it("is a no-op when there is no composition root", () => {
    const source = `<div data-duration="5">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(source);
  });
});

describe("resolveTimelineAssetCompositionSize", () => {
  it("uses the target composition dimensions for visual media", () => {
    expect(
      resolveTimelineAssetCompositionSize(
        `<div data-composition-id="main" data-width="330" data-height="228"></div>`,
      ),
    ).toEqual({
      width: 330,
      height: 228,
    });
  });
});

describe("buildTimelineFileDropPlacements", () => {
  it("returns no placements for an empty drop set", () => {
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [])).toEqual([]);
  });

  it("spaces multiple files by duration and keeps every one on the dropped track", () => {
    // A clip placed onto an occupied track stays there (overlap is allowed); it is
    // NOT bumped to a new track — that produced surprise empty tracks for users.
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [1.2, 1.6, 1.1])).toEqual([
      { start: 1.5, track: 2 },
      { start: 2.7, track: 2 },
      { start: 4.3, track: 2 },
    ]);
  });

  it("uses fallback spacing when a duration is unavailable", () => {
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [1.2, 0, 1.1])).toEqual([
      { start: 1.5, track: 2 },
      { start: 2.7, track: 2 },
      { start: 7.7, track: 2 },
    ]);
  });
});
