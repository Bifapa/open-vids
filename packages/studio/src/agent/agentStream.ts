/** What the store needs from an `EventSource`; the real one satisfies it, tests bring a fake. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamHandle {
  close(): void;
}

export interface StreamOptions {
  open: EventSourceFactory;
  /** Read on every (re)connect, so a chat stream resumes after the seq folded in so far. */
  url: () => string;
  /** SSE event name carrying the payloads. */
  event: string;
  onData: (data: string) => void;
  /** `reconnect` is true for every open after the first. */
  onOpen?: (reconnect: boolean) => void;
  onStatus?: (status: StreamStatus) => void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/**
 * One SSE subscription that survives failure. A native `EventSource` gives up for good on a
 * non-200 answer (the gateway's 503 while the runtime restarts), so every error closes the source
 * and a fresh one is opened with back-off, at whatever `url()` says by then.
 */
export function openStream(options: StreamOptions): StreamHandle {
  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let opened = false;
  let closed = false;

  const connect = () => {
    if (closed) return;
    let next: EventSourceLike;
    try {
      next = options.open(options.url());
    } catch {
      scheduleRetry();
      return;
    }
    source = next;
    next.addEventListener(options.event, (event) => {
      if (closed || source !== next) return;
      if (event instanceof MessageEvent && typeof event.data === "string")
        options.onData(event.data);
    });
    next.onopen = () => {
      if (closed || source !== next) return;
      failures = 0;
      options.onStatus?.("open");
      options.onOpen?.(opened);
      opened = true;
    };
    next.onerror = () => {
      if (closed || source !== next) return;
      next.close();
      source = null;
      scheduleRetry();
    };
  };

  function scheduleRetry() {
    if (closed) return;
    options.onStatus?.("reconnecting");
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** failures);
    failures += 1;
    timer = setTimeout(connect, delay);
  }

  options.onStatus?.("connecting");
  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      source?.close();
      source = null;
      options.onStatus?.("closed");
    },
  };
}

/** The browser's `EventSource`, wrapped for the store. */
export const browserEventSource: EventSourceFactory = (url) => new EventSource(url);
