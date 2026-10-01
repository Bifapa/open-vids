// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

/** A `prefers-color-scheme` query whose answer the test flips. */
function fakeColorScheme(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function preferences(theme: string) {
  return {
    version: 1,
    theme,
    newProject: {
      location: "~/Movies/OpenVids",
      openIn: "media",
      width: 1920,
      height: 1080,
      fps: 24,
    },
    confirmTrash: true,
    onLaunch: "projects",
  };
}

async function boot(search: string, answer: Promise<Response>) {
  vi.resetModules();
  window.history.replaceState(null, "", `/${search}`);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => answer),
  );
  // Dynamic on purpose: each test boots a fresh module, as a page load does (startAppTheme subscribes the
  // module's preferences store once per boot).
  const { startAppTheme } = await import("./appTheme");
  startAppTheme();
}

const theme = () => document.documentElement.dataset.theme;
/** Lets the preferences read (fetch, then the body) land. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it("paints the desktop's theme before the preferences arrive, then follows them", async () => {
  fakeColorScheme(false);
  const { promise, resolve } = Promise.withResolvers<Response>();
  await boot("?openvidsTheme=light", promise);
  expect(theme()).toBe("light");

  resolve(Response.json(preferences("dark")));
  await settle();
  expect(theme()).toBe("dark");
});

it("ignores an unknown theme parameter", async () => {
  fakeColorScheme(false);
  await boot("?openvidsTheme=neon", Promise.withResolvers<Response>().promise);
  expect(theme()).toBeUndefined();
});

it("follows the system appearance live while the preference is Match system", async () => {
  const scheme = fakeColorScheme(true);
  await boot("", Promise.resolve(Response.json(preferences("system"))));
  await settle();
  expect(theme()).toBe("light");

  scheme.set(false);
  expect(theme()).toBe("dark");
});

it("keeps an explicit theme when the system appearance changes", async () => {
  const scheme = fakeColorScheme(false);
  await boot("", Promise.resolve(Response.json(preferences("light"))));
  await settle();
  scheme.set(false);
  expect(theme()).toBe("light");
});
