import type { Browser, Page } from "puppeteer-core";

interface LoadedPage {
  url: string;
  browser: Browser;
  version: string;
  /** The latest time scheduled on the page; its frames run in order, so this is where it ends up. */
  shownUpTo: number;
  page: Promise<Page>;
  queue: Promise<unknown>;
  /** Frames scheduled on the page and not finished yet. */
  pending: number;
  /** Order of last use, for evicting the page that has been idle longest. */
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Loaded preview pages, up to `maxPages` in all: a thumbnail is a seek and a screenshot on a
 * page that already shows the document, not a fresh load of the whole composition. Frames of one
 * document go to an idle page first, then to a new page while there is room, so two frames are
 * taken in parallel; a page runs its own frames one at a time so their seeks never interleave. A
 * page only seeks forward, as a render does: a composition need not draw the same frame when
 * seeked back, so an earlier time than every page shows gets a fresh page. A new `version`
 * (project content) drops the document's pages, and a page unused for `idleMs` closes so an idle
 * Studio keeps no composition running. */
export function createThumbnailPages(maxPages = 2, idleMs = 1_000) {
  const pages: LoadedPage[] = [];
  let useCounter = 0;

  const drop = (entry: LoadedPage) => {
    const index = pages.indexOf(entry);
    if (index === -1) return;
    pages.splice(index, 1);
    clearTimeout(entry.idleTimer);
    // After any frame still running on it.
    void entry.queue
      .then(() => entry.page)
      .then((page) => page.close())
      .catch(() => {});
  };

  const evictOverCapacity = (keep: LoadedPage) => {
    while (pages.length > maxPages) {
      const others = pages.filter((entry) => entry !== keep);
      // An idle page goes first; one with frames still queued closes once they finish.
      const victim = [...others].sort(
        (a, b) => Number(a.pending > 0) - Number(b.pending > 0) || a.lastUsed - b.lastUsed,
      )[0];
      if (!victim) return;
      drop(victim);
    }
  };

  const open = (
    browser: Browser,
    url: string,
    version: string,
    load: (page: Page) => Promise<void>,
  ): LoadedPage => {
    const page = browser.newPage().then(async (created) => {
      try {
        await load(created);
      } catch (error) {
        // The page never leaves this promise, so a failed load has to close it here.
        await created.close().catch(() => {});
        throw error;
      }
      return created;
    });
    const entry: LoadedPage = {
      url,
      browser,
      version,
      shownUpTo: Number.NEGATIVE_INFINITY,
      page,
      queue: Promise.resolve(),
      pending: 0,
      lastUsed: useCounter,
    };
    pages.push(entry);
    evictOverCapacity(entry);
    return entry;
  };

  const pick = (
    browser: Browser,
    url: string,
    version: string,
    time: number,
    load: (page: Page) => Promise<void>,
  ): LoadedPage => {
    for (const entry of pages.filter((e) => e.url === url)) {
      if (entry.browser !== browser || entry.version !== version) drop(entry);
    }
    const fitting = pages.filter((entry) => entry.url === url && entry.shownUpTo <= time);
    const closestFirst = (a: LoadedPage, b: LoadedPage) => b.shownUpTo - a.shownUpTo;
    const idle = fitting.filter((entry) => entry.pending === 0).sort(closestFirst)[0];
    if (idle) return idle;
    if (pages.length < maxPages || fitting.length === 0) return open(browser, url, version, load);
    // No room for another page: wait behind the least busy page that can still show `time`.
    return [...fitting].sort((a, b) => a.pending - b.pending || closestFirst(a, b))[0]!;
  };

  const armIdleClose = (entry: LoadedPage) => {
    if (!pages.includes(entry) || entry.pending > 0) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.pending === 0) drop(entry);
    }, idleMs);
    entry.idleTimer.unref?.();
  };

  return {
    async withPage<T>(
      browser: Browser,
      url: string,
      version: string,
      time: number,
      load: (page: Page) => Promise<void>,
      use: (page: Page) => Promise<T>,
    ): Promise<T> {
      const current = pick(browser, url, version, time, load);
      clearTimeout(current.idleTimer);
      current.shownUpTo = Math.max(current.shownUpTo, time);
      current.pending++;
      current.lastUsed = ++useCounter;
      const run = current.queue.then(async () => use(await current.page));
      current.queue = run.catch(() => {});
      try {
        return await run;
      } catch (error) {
        drop(current);
        throw error;
      } finally {
        current.pending--;
        armIdleClose(current);
      }
    },
    closeAll(): void {
      for (const entry of [...pages]) drop(entry);
    },
  };
}
