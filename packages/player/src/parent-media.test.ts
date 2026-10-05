import { afterEach, describe, it, expect, vi } from "vitest";
import { ParentMediaManager, type ProxyEntry } from "./parent-media";

// A fake media element whose paused state is driven by play()/pause() stubs.
function makeFakeAudio(initiallyPaused: boolean): HTMLMediaElement {
  const el = new Audio();
  let paused = initiallyPaused;
  Object.defineProperty(el, "paused", { get: () => paused });
  el.pause = () => {
    paused = true;
  };
  el.play = () => {
    paused = false;
    return Promise.resolve();
  };
  el.src = "https://example.test/music.mp3";
  return el;
}

function makeManager(overrides: Partial<{ isPaused: boolean; owner: "runtime" | "parent" }> = {}) {
  const mgr = new ParentMediaManager({
    dispatchEvent: () => {},
    getMuted: () => false,
    getVolume: () => 1,
    getPlaybackRate: () => 1,
    getCurrentTime: () => 0,
    isPaused: () => overrides.isPaused ?? true,
  });
  return mgr;
}

describe("ParentMediaManager audio-src proxy lifecycle", () => {
  it("replaces the audio-src proxy instead of stacking a second one", () => {
    const mgr = makeManager();
    mgr.setupFromUrl("https://example.test/a.mp3");
    expect(mgr.entries).toHaveLength(1);

    mgr.setupFromUrl("https://example.test/b.mp3");
    // The old proxy must be gone, not accumulated alongside the new one.
    expect(mgr.entries).toHaveLength(1);
    expect(mgr.entries[0].el.src).toBe("https://example.test/b.mp3");
  });

  it("is a no-op when the same audio-src URL is set again", () => {
    const mgr = makeManager();
    mgr.setupFromUrl("https://example.test/a.mp3");
    const first = mgr.entries[0];

    mgr.setupFromUrl("https://example.test/a.mp3");
    expect(mgr.entries).toHaveLength(1);
    // Same element reference — not torn down and rebuilt.
    expect(mgr.entries[0]).toBe(first);
  });

  it("clears the audio-src proxy on teardownUrlAudio", () => {
    const mgr = makeManager();
    mgr.setupFromUrl("https://example.test/a.mp3");
    const el = mgr.entries[0].el;

    mgr.teardownUrlAudio();
    expect(mgr.entries).toHaveLength(0);
    // The proxy's source is reset so it stops preloading.
    expect(el.src).not.toBe("https://example.test/a.mp3");
  });

  it("teardownUrlAudio removes only the url proxy, leaving other entries", () => {
    const mgr = makeManager();
    // Simulate an iframe-adopted entry already in the pool.
    const adopted: ProxyEntry = {
      el: new Audio(),
      start: 0,
      duration: Infinity,
      driftSamples: 0,
    };
    adopted.el.src = "https://example.test/iframe-clip.mp4";
    mgr.entries.push(adopted);

    mgr.setupFromUrl("https://example.test/a.mp3");
    expect(mgr.entries).toHaveLength(2);

    mgr.teardownUrlAudio();
    expect(mgr.entries).toHaveLength(1);
    expect(mgr.entries[0]).toBe(adopted);
  });

  it("teardownUrlAudio is safe to call with no audio-src set", () => {
    const mgr = makeManager();
    expect(() => mgr.teardownUrlAudio()).not.toThrow();
    expect(mgr.entries).toHaveLength(0);
  });

  it("pauses a proxy once the playhead passes the clip end (trimmed clip)", () => {
    const mgr = makeManager({ owner: "parent", isPaused: false });
    const el = makeFakeAudio(false); // already playing within the clip
    mgr.entries.push({ el, start: 0, duration: 5, driftSamples: 0 });

    mgr.mirrorTime(3); // inside [0, 5) — stays playing
    expect(el.paused).toBe(false);

    mgr.mirrorTime(6); // past the trimmed end — must pause
    expect(el.paused).toBe(true);
  });

  it("re-reads the source element's live data-duration so trims bound the proxy", () => {
    const mgr = makeManager({ owner: "parent", isPaused: false });
    const source = new Audio();
    source.setAttribute("data-start", "0");
    source.setAttribute("data-duration", "30");
    // jsdom reports isConnected=false unless attached; attach it.
    document.body.appendChild(source);

    const el = makeFakeAudio(false);
    mgr.entries.push({ el, start: 0, duration: 30, driftSamples: 0, source });

    mgr.mirrorTime(20); // within 30 → playing
    expect(el.paused).toBe(false);

    // User trims the clip to 10s; the proxy must pick it up and pause at 20s.
    source.setAttribute("data-duration", "10");
    mgr.mirrorTime(20);
    expect(el.paused).toBe(true);
    source.remove();
  });

  it("scrubAll plays in-window proxies at the playhead and pauses out-of-window ones", () => {
    const mgr = makeManager({ owner: "parent" });
    const inWin = makeFakeAudio(true); // currently paused — scrub should start it
    const outWin = makeFakeAudio(false); // currently playing, but outside its window
    mgr.entries.push({ el: inWin, start: 0, duration: 5, driftSamples: 0 });
    mgr.entries.push({ el: outWin, start: 10, duration: 5, driftSamples: 0 });

    mgr.scrubAll(2); // playhead at 2s

    // in-window proxy: positioned at rel time and AUDIBLE (the point of scrub-audio)
    expect(inWin.currentTime).toBe(2);
    expect(inWin.paused).toBe(false);
    // out-of-window proxy: paused, not blipped
    expect(outWin.paused).toBe(true);
  });

  it("does not duplicate or hijack a clip the composition already owns", () => {
    const mgr = makeManager();
    // The composition already adopted a clip with this URL.
    const adopted: ProxyEntry = {
      el: new Audio(),
      start: 0,
      duration: Infinity,
      driftSamples: 0,
    };
    adopted.el.src = "https://example.test/shared.mp3";
    mgr.entries.push(adopted);

    // Pointing audio-src at the same URL must not create a second proxy...
    mgr.setupFromUrl("https://example.test/shared.mp3");
    expect(mgr.entries).toHaveLength(1);
    expect(mgr.entries[0]).toBe(adopted);

    // ...and removing audio-src must not tear down the composition's own clip
    // (teardown targets the tracked proxy by reference, not by URL match).
    mgr.teardownUrlAudio();
    expect(mgr.entries).toHaveLength(1);
    expect(mgr.entries[0]).toBe(adopted);
  });
});

function addClip(
  src: string,
  attrs: Record<string, string> = {},
  tag: "audio" | "video" = "audio",
): HTMLMediaElement {
  const el = document.createElement(tag);
  if (src) el.setAttribute("src", src);
  el.setAttribute("data-start", "0");
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.preload = "auto";
  document.body.appendChild(el);
  return el;
}

function finishLoad(entry: ProxyEntry, type: "loadedmetadata" | "error" = "loadedmetadata"): void {
  entry.el.dispatchEvent(new Event(type));
}

describe("ParentMediaManager across documents", () => {
  afterEach(() => document.body.replaceChildren());

  it("drops the previous document's proxies on reset and keeps the audio-src one", () => {
    const mgr = makeManager();
    mgr.setupFromUrl("https://example.test/narration.mp3");
    addClip("https://example.test/old-film.mp3");
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(2);
    const oldProxy = mgr.entries[1].el;

    mgr.resetForIframeLoad();

    expect(mgr.entries.map((m) => m.el.src)).toEqual(["https://example.test/narration.mp3"]);
    expect(oldProxy.getAttribute("src")).toBe("");
  });

  it("keeps the audio-src track after a reset when the old document shared its URL", () => {
    const mgr = makeManager();
    addClip("https://example.test/narration.mp3", { "data-start": "2", "data-duration": "3" });
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    mgr.setupFromUrl("https://example.test/narration.mp3");
    expect(mgr.entries).toHaveLength(1);

    mgr.resetForIframeLoad();

    expect(mgr.entries.map((m) => [m.el.src, m.start, m.duration])).toEqual([
      ["https://example.test/narration.mp3", 0, Infinity],
    ]);
  });
});

describe("ParentMediaManager lazy iframe proxies", () => {
  afterEach(() => document.body.replaceChildren());

  it("creates no proxy for iframe media while the runtime owns audio", async () => {
    const mgr = makeManager();
    addClip("https://example.test/a.mp4", {}, "video");
    mgr.setupFromIframe(document);
    expect(mgr.entries).toHaveLength(0);

    // Late sources (preload flip / new nodes) are ignored as well.
    addClip("https://example.test/b.mp4", {}, "video");
    await Promise.resolve();
    expect(mgr.entries).toHaveLength(0);
    mgr.destroy();
  });

  it("promotion materializes the clips already present in the iframe document", () => {
    const mgr = makeManager();
    addClip("https://example.test/a.mp4", { "data-start": "1", "data-duration": "4" }, "video");
    addClip("https://example.test/b.mp3");
    mgr.setupFromIframe(document);
    expect(mgr.entries).toHaveLength(0);

    mgr.promoteToParentProxy(document);

    expect(mgr.audioOwner).toBe("parent");
    expect(mgr.entries.map((m) => [m.el.tagName, m.el.src, m.start, m.duration])).toEqual([
      ["VIDEO", "https://example.test/a.mp4", 1, 4],
      ["AUDIO", "https://example.test/b.mp3", 0, Infinity],
    ]);
    mgr.destroy();
  });

  it("adopts sources that appear after promotion", async () => {
    const mgr = makeManager();
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(0);

    addClip("https://example.test/late.mp3");
    await Promise.resolve();

    expect(mgr.entries.map((m) => m.el.src)).toEqual(["https://example.test/late.mp3"]);
    mgr.destroy();
  });

  it("reads a released element's parked source only to skip it, and adopts it on re-attach", async () => {
    const mgr = makeManager();
    const released = addClip("", { "data-hf-detached-src": "https://example.test/a.mp4" }, "video");
    released.preload = "none";
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(0);

    released.setAttribute("src", "https://example.test/a.mp4");
    released.removeAttribute("data-hf-detached-src");
    released.preload = "auto";
    await Promise.resolve();

    expect(mgr.entries.map((m) => m.el.src)).toEqual(["https://example.test/a.mp4"]);
    mgr.destroy();
  });

  it("removes a released element's proxy by its parked source", async () => {
    const mgr = makeManager();
    const clip = addClip("https://example.test/a.mp4", {}, "video");
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(1);

    // The preview parks the source, then the node leaves the document.
    clip.removeAttribute("src");
    clip.setAttribute("data-hf-detached-src", "https://example.test/a.mp4");
    clip.remove();
    await Promise.resolve();

    expect(mgr.entries).toHaveLength(0);
    mgr.destroy();
  });
});

describe("ParentMediaManager clips sharing one source file", () => {
  afterEach(() => document.body.replaceChildren());

  const shared = "https://example.test/sfx.mp3";

  function promotedWithTwoRanges() {
    const mgr = makeManager();
    const first = addClip(shared, { "data-start": "1", "data-duration": "2" });
    const second = addClip(shared, { "data-start": "8", "data-duration": "3" });
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    return { mgr, first, second };
  }

  it("gives every clip its own proxy with its own bounds", () => {
    const { mgr, first, second } = promotedWithTwoRanges();

    expect(mgr.entries.map((m) => [m.el.src, m.start, m.duration, m.source])).toEqual([
      [shared, 1, 2, first],
      [shared, 8, 3, second],
    ]);
    mgr.destroy();
  });

  it("plays the later occurrence inside its own window", () => {
    const { mgr } = promotedWithTwoRanges();

    mgr.scrubAll(9);

    const [early, late] = mgr.entries;
    expect(early.el.paused).toBe(true);
    expect(late.el.currentTime).toBe(1);
    expect(late.el.paused).toBe(false);
    mgr.destroy();
  });

  it("removing one clip leaves the other clip's proxy alone", async () => {
    const { mgr, first, second } = promotedWithTwoRanges();
    const kept = mgr.entries[1];

    first.remove();
    await Promise.resolve();

    expect(mgr.entries).toEqual([kept]);
    expect(kept.source).toBe(second);
    expect(kept.el.src).toBe(shared);
    mgr.destroy();
  });

  it("removing a clip keeps the audio-src proxy that shares its URL", async () => {
    const mgr = makeManager();
    const clip = addClip(shared, { "data-start": "2", "data-duration": "3" });
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    // The composition owns the URL, so audio-src defers to its clip until a reset.
    mgr.setupFromUrl(shared);
    mgr.resetForIframeLoad();
    const track = mgr.entries[0];
    expect(track.source ?? null).toBeNull();

    const later = addClip(shared, { "data-start": "5", "data-duration": "1" });
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(3);
    later.remove();
    clip.remove();
    await Promise.resolve();

    expect(mgr.entries).toEqual([track]);
    expect(track.el.src).toBe(shared);
    mgr.destroy();
  });

  it("does not queue the same element twice", () => {
    const mgr = makeManager();
    const clip = addClip(shared, { "data-start": "1" });
    mgr.promoteToParentProxy(document);
    mgr.setupFromIframe(document);
    mgr.setupFromIframe(document);

    expect(mgr.entries.map((m) => m.source)).toEqual([clip]);
    mgr.destroy();
  });
});

describe("ParentMediaManager proxy load bound", () => {
  afterEach(() => document.body.replaceChildren());

  function promotedWith(count: number) {
    const mgr = makeManager();
    for (let i = 0; i < count; i++) addClip(`https://example.test/clip-${i}.mp4`, {}, "video");
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    return mgr;
  }

  const srcs = (mgr: ParentMediaManager) => mgr.entries.map((m) => m.el.src.split("/").pop());

  it("keeps at most three unsettled proxy loads and starts the rest FIFO as loads settle", () => {
    const mgr = promotedWith(6);
    expect(srcs(mgr)).toEqual(["clip-0.mp4", "clip-1.mp4", "clip-2.mp4"]);

    finishLoad(mgr.entries[1]);
    expect(srcs(mgr)).toEqual(["clip-0.mp4", "clip-1.mp4", "clip-2.mp4", "clip-3.mp4"]);

    // A failed load frees its slot as well.
    finishLoad(mgr.entries[0], "error");
    expect(srcs(mgr)).toEqual([
      "clip-0.mp4",
      "clip-1.mp4",
      "clip-2.mp4",
      "clip-3.mp4",
      "clip-4.mp4",
    ]);

    // A second settle event from the same proxy must not free another slot.
    finishLoad(mgr.entries[1]);
    expect(mgr.entries).toHaveLength(5);

    finishLoad(mgr.entries[2]);
    expect(srcs(mgr).at(-1)).toBe("clip-5.mp4");
    mgr.destroy();
  });

  it("drives proxies that exist while later ones are still queued", () => {
    const mgr = promotedWith(5);
    expect(mgr.entries).toHaveLength(3);
    mgr.updateMuted(true);
    mgr.seekAll(2);
    for (const m of mgr.entries) {
      expect(m.el.muted).toBe(true);
      expect(m.el.currentTime).toBe(2);
    }
    mgr.destroy();
  });

  it("a queued proxy starts playing when its load slot opens during playback", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const mgr = makeManager({ isPaused: false });
    for (let i = 0; i < 4; i++) addClip(`https://example.test/clip-${i}.mp4`, {}, "video");
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(3);
    const playingBefore = play.mock.contexts.length;

    finishLoad(mgr.entries[0]);

    expect(mgr.entries).toHaveLength(4);
    expect(play.mock.contexts.slice(playingBefore)).toContain(mgr.entries[3].el);
    mgr.destroy();
    play.mockRestore();
  });

  // A fresh, empty iframe document promoted after the drop: anything still queued
  // from the old document would start now, because every load slot is free.
  function promoteFreshDocument(mgr: ParentMediaManager): void {
    const fresh = document.implementation.createHTMLDocument("fresh");
    const clip = fresh.createElement("audio");
    clip.setAttribute("src", "https://example.test/fresh.mp3");
    clip.setAttribute("data-start", "0");
    fresh.body.appendChild(clip);
    mgr.promoteToParentProxy(fresh);
  }

  it("reset drops queued clips so they never start", () => {
    const mgr = promotedWith(5);
    mgr.resetForIframeLoad();
    expect(mgr.entries).toHaveLength(0);

    promoteFreshDocument(mgr);
    expect(srcs(mgr)).toEqual(["fresh.mp3"]);
    mgr.destroy();
  });

  it("destroy drops queued clips so they never start", () => {
    const mgr = promotedWith(5);
    mgr.destroy();
    expect(mgr.entries).toHaveLength(0);

    promoteFreshDocument(mgr);
    expect(srcs(mgr)).toEqual(["fresh.mp3"]);
    mgr.destroy();
  });

  it("skips a queued clip whose source was released while it waited", () => {
    const mgr = makeManager();
    const clips = [0, 1, 2, 3, 4].map((i) =>
      addClip(`https://example.test/clip-${i}.mp4`, {}, "video"),
    );
    mgr.setupFromIframe(document);
    mgr.promoteToParentProxy(document);
    expect(mgr.entries).toHaveLength(3);

    clips[3].setAttribute("data-hf-detached-src", "https://example.test/clip-3.mp4");
    clips[3].removeAttribute("src");
    finishLoad(mgr.entries[0]);
    // clip-3 is skipped; the freed slot goes to the next queued clip.
    expect(srcs(mgr)).toEqual(["clip-0.mp4", "clip-1.mp4", "clip-2.mp4", "clip-4.mp4"]);
    mgr.destroy();
  });
});

describe("ParentMediaManager clip window", () => {
  it("plays a proxy inside its clip window and pauses it at the clip end instant", () => {
    const mgr = makeManager({ isPaused: false, owner: "parent" });
    const el = makeFakeAudio(false);
    mgr.entries.push({ el, start: 1, duration: 2, driftSamples: 0 });

    mgr.mirrorTime(2.999);
    expect(el.paused).toBe(false);
    mgr.mirrorTime(3);
    expect(el.paused).toBe(true);
  });
});
