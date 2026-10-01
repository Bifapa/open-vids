// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail";
import { MAX_CONCURRENT_MEDIA_ELEMENT_LOADS } from "../../utils/mediaLoadGate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The component builds its thumbnail from document.createElement("video"/"canvas"),
// so both are faked here. The video fake records load() calls and keeps listener
// sets, letting a test re-fire an event handler after cleanup removed it — the
// exact shape of the error→cleanup→error loop this suite guards against.
interface FakeVideo {
  crossOrigin: string;
  muted: boolean;
  preload: string;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  loadCalls: number;
  _src: string;
  src: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  getAttribute(name: string): string | null;
  load(): void;
  dispatch(type: string): void;
}

function makeVideo(): FakeVideo {
  const listeners = new Map<string, Set<() => void>>();
  const video: FakeVideo = {
    crossOrigin: "",
    muted: false,
    preload: "",
    duration: 10,
    videoWidth: 640,
    videoHeight: 360,
    currentTime: 0,
    loadCalls: 0,
    _src: "",
    src: "",
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    getAttribute(name) {
      return name === "src" ? video.src : null;
    },
    load() {
      video.loadCalls++;
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
  Object.defineProperty(video, "src", {
    get: () => video._src,
    set: (v: string) => {
      video._src = v;
    },
  });
  return video;
}

const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({ drawImage: () => {} }),
  toDataURL: () => "data:image/jpeg;base64,AAAA",
};

describe("VideoFrameThumbnail", () => {
  let videos: FakeVideo[];
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    videos = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "video") {
        const v = makeVideo();
        videos.push(v);
        return v as unknown as HTMLVideoElement;
      }
      if (tag === "canvas") return canvas as unknown as HTMLCanvasElement;
      return original(tag);
    }) as typeof document.createElement);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // The video is created once a media-load slot is granted (a microtask later),
  // so renders are awaited inside an async act.
  const render = async (props: { src: string; fallbackLabel?: string }) => {
    await act(async () => root.render(<VideoFrameThumbnail {...props} />));
    return videos[videos.length - 1];
  };

  it("renders the fallback label when the video errors", async () => {
    await render({ src: "missing.mp4", fallbackLabel: "VIDEO" });
    const video = videos[0];
    expect(video.src).toBe("missing.mp4");
    expect(video.loadCalls).toBe(1);

    act(() => video.dispatch("error"));

    expect(container.textContent).toContain("VIDEO");
    // cleanup ran once: detached the error listener and reset the media element
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(2);
  });

  it("does not loop when the cleared src fires a synthetic error", async () => {
    await render({ src: "missing.mp4", fallbackLabel: "VIDEO" });
    const video = videos[0];
    act(() => video.dispatch("error"));
    expect(video.loadCalls).toBe(2);

    // The empty src makes the browser fire `error` again; the detached handler
    // must stay detached — repeated dispatches must not touch load() anymore.
    act(() => {
      video.dispatch("error");
      video.dispatch("error");
      video.dispatch("error");
    });

    expect(video.loadCalls).toBe(2);
    expect(container.textContent).toContain("VIDEO");
  });

  it("keeps the extracted frame and stays inert after a post-seek synthetic error", async () => {
    await render({ src: "clip.mp4" });
    const video = videos[0];

    act(() => video.dispatch("loadedmetadata"));
    expect(video.currentTime).toBe(1); // 10% of a 10s clip

    act(() => video.dispatch("seeked"));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(2);

    act(() => {
      video.dispatch("error");
      video.dispatch("error");
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(video.loadCalls).toBe(2);
  });

  it("retries with a fresh video element when src changes", async () => {
    await render({ src: "a.mp4" });
    await act(async () => root.render(<VideoFrameThumbnail src="b.mp4" />));
    expect(videos.length).toBe(2);
    expect(videos[1].src).toBe("b.mp4");
  });

  it("creates at most MAX_CONCURRENT_MEDIA_ELEMENT_LOADS videos when 10 thumbnails mount", async () => {
    await act(async () =>
      root.render(
        <>
          {Array.from({ length: 10 }, (_, i) => (
            <VideoFrameThumbnail key={i} src={`clip-${i}.mp4`} />
          ))}
        </>,
      ),
    );
    expect(videos).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS);

    // Settling one probe (frame captured) lets exactly the next one start.
    await act(async () => {
      videos[0].dispatch("loadedmetadata");
      videos[0].dispatch("seeked");
    });
    expect(videos).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 1);
    expect(videos[MAX_CONCURRENT_MEDIA_ELEMENT_LOADS]?.src).toBe(
      `clip-${MAX_CONCURRENT_MEDIA_ELEMENT_LOADS}.mp4`,
    );

    // An errored probe frees its slot too.
    await act(async () => videos[1].dispatch("error"));
    expect(videos).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 2);
  });

  it("cancels queued thumbnails on unmount without ever creating their video", async () => {
    await act(async () =>
      root.render(
        <>
          {Array.from({ length: 6 }, (_, i) => (
            <VideoFrameThumbnail key={i} src={`clip-${i}.mp4`} />
          ))}
        </>,
      ),
    );
    expect(videos).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS);

    await act(async () => root.render(<VideoFrameThumbnail src="solo.mp4" />));
    // The three live probes were torn down and freed their slots; the
    // cancelled waiters never took one, so only the new thumbnail's video appears.
    expect(videos).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 1);
    expect(videos[MAX_CONCURRENT_MEDIA_ELEMENT_LOADS]?.src).toBe("solo.mp4");
  });
});
