// @vitest-environment happy-dom

/**
 * The project tab strip: who is selected, what a click, a ×, a spinner and the keys do, and that the page
 * draws nothing at all when tabs are off. The view takes its data as props; the wrapper is exercised
 * against a stand-in for the shell's home server.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ProjectTab } from "../../utils/openvidsTabs";
import { isTypingTarget } from "../../utils/typingTarget";
import { ProjectTabStrip, ProjectTabStripView } from "./ProjectTabStrip";

// happy-dom's globalThis lacks the React act-environment flag type.
const reactActEnv: { IS_REACT_ACT_ENVIRONMENT: boolean } = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
reactActEnv.IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "http://127.0.0.1:57035";
const OWN = "9f2c0a41b7d3e8c5";
const SECOND = "0123456789abcdef";
const BUSY = "fedcba9876543210";

const TABS: ProjectTab[] = [
  { key: OWN, name: "Alpha", state: "open" },
  { key: BUSY, name: "Starting", state: "opening" },
  { key: SECOND, name: "Beta", state: "open" },
];

let root: Root | null = null;
let hostEl: HTMLElement | null = null;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function render(element: ReactElement): HTMLElement {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  const mounted = createRoot(hostEl);
  root = mounted;
  act(() => mounted.render(element));
  return hostEl;
}

interface Handlers {
  onActivate: Mock<(key: string) => void>;
  onClose: Mock<(key: string) => void>;
}

function renderView(
  props: { tabs?: ProjectTab[]; selectedKey?: string; closingKey?: string | null } = {},
): { host: HTMLElement } & Handlers {
  const onActivate = vi.fn<(key: string) => void>();
  const onClose = vi.fn<(key: string) => void>();
  const host = render(
    <ProjectTabStripView
      selectedKey={props.selectedKey ?? OWN}
      tabs={props.tabs ?? TABS}
      closingKey={props.closingKey ?? null}
      onActivate={onActivate}
      onClose={onClose}
    />,
  );
  return { host, onActivate, onClose };
}

function tab(host: HTMLElement, key: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-key="${key}"]`);
  if (!el) throw new Error(`no tab ${key}`);
  return el;
}

function closeButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="project-tab-close"]'));
}

function press(el: Element, key: string): boolean {
  let notCancelled = true;
  act(() => {
    notCancelled = el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  return notCancelled;
}

describe("ProjectTabStripView", () => {
  it("is a labelled tablist: Projects first, then the project tabs in order, + after them", () => {
    const { host } = renderView();
    const list = host.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toBe("Open projects");
    const tabs = Array.from(list?.querySelectorAll('[role="tab"]') ?? []);
    expect(tabs.map((el) => el.getAttribute("data-tab-key"))).toEqual(["home", OWN, BUSY, SECOND]);
    expect(tabs[0].textContent).toBe("Projects");
    expect(tabs.slice(1).map((el) => el.textContent)).toEqual(["Alpha", "Starting", "Beta"]);
    const plus = host.querySelector('button[aria-label="Open another project"]');
    expect(plus).not.toBeNull();
    expect(list?.contains(plus)).toBe(false);
  });

  it("marks the page's own tab selected and nothing else", () => {
    const { host } = renderView({ selectedKey: SECOND });
    const selected = Array.from(host.querySelectorAll('[role="tab"][aria-selected="true"]'));
    expect(selected.map((el) => el.getAttribute("data-tab-key"))).toEqual([SECOND]);
    expect(host.querySelectorAll('[role="tab"][aria-selected="false"]')).toHaveLength(3);
  });

  it("activates the tab that is clicked, Projects and + go home, the selected tab does nothing", () => {
    const { host, onActivate } = renderView();
    act(() => tab(host, SECOND).click());
    expect(onActivate).toHaveBeenLastCalledWith(SECOND);
    act(() => tab(host, "home").click());
    expect(onActivate).toHaveBeenLastCalledWith("home");
    act(() =>
      host.querySelector<HTMLElement>('button[aria-label="Open another project"]')?.click(),
    );
    expect(onActivate).toHaveBeenLastCalledWith("home");
    expect(onActivate).toHaveBeenCalledTimes(3);

    act(() => tab(host, OWN).click());
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("shows a spinner instead of a × on a tab that is still opening, and the tab is inert", () => {
    const { host, onActivate, onClose } = renderView();
    const opening = tab(host, BUSY);
    expect(opening.getAttribute("aria-disabled")).toBe("true");
    expect(opening.getAttribute("aria-busy")).toBe("true");
    expect(opening.getAttribute("aria-label")).toBe("Opening Starting…");
    const box = opening.parentElement;
    expect(box?.querySelector(".animate-spin")).not.toBeNull();
    expect(box?.querySelector('[data-testid="project-tab-close"]')).toBeNull();

    act(() => opening.click());
    press(opening, "Delete");
    expect(onActivate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Settled tabs have a × and no spinner.
    expect(tab(host, OWN).parentElement?.querySelector(".animate-spin")).toBeNull();
    expect(closeButtons(host).map((el) => el.getAttribute("aria-label"))).toEqual([
      "Close Alpha",
      "Close Beta",
    ]);
  });

  it("closes through the × once, never through the Projects tab", () => {
    const { host, onClose, onActivate } = renderView();
    act(() => closeButtons(host)[1].click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(SECOND);
    // The × belongs to its tab, not to the tab's own button.
    expect(onActivate).not.toHaveBeenCalled();
    expect(
      tab(host, "home").parentElement?.querySelector("[data-testid='project-tab-close']"),
    ).toBeNull();
  });

  it("turns every × off while a close waits on the shell, and the Delete key with them", () => {
    const { host, onClose } = renderView({ closingKey: SECOND });
    const buttons = closeButtons(host);
    expect(buttons.map((el) => el.disabled)).toEqual([true, true]);
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    press(tab(host, SECOND), "Delete");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps one tab in the Tab order: the selected one first, then the last one focused", () => {
    const { host } = renderView();
    const stops = () =>
      Array.from(host.querySelectorAll('[role="tab"]'))
        .filter((el) => el.getAttribute("tabindex") === "0")
        .map((el) => el.getAttribute("data-tab-key"));
    expect(stops()).toEqual([OWN]);
    act(() => tab(host, SECOND).focus());
    expect(stops()).toEqual([SECOND]);
    // The × buttons stay out of the Tab order: Delete closes the focused tab instead.
    expect(closeButtons(host).every((el) => el.tabIndex === -1)).toBe(true);
  });

  it("moves focus with the arrows (wrapping), Home and End, skipping a tab that is still opening", () => {
    const { host, onActivate } = renderView();
    const focused = () => document.activeElement?.getAttribute("data-tab-key");
    act(() => tab(host, "home").focus());

    expect(press(tab(host, "home"), "ArrowRight")).toBe(false);
    expect(focused()).toBe(OWN);
    press(tab(host, OWN), "ArrowRight");
    expect(focused()).toBe(SECOND);
    press(tab(host, SECOND), "ArrowRight");
    expect(focused()).toBe("home");
    press(tab(host, "home"), "ArrowLeft");
    expect(focused()).toBe(SECOND);
    press(tab(host, SECOND), "ArrowLeft");
    expect(focused()).toBe(OWN);
    press(tab(host, OWN), "End");
    expect(focused()).toBe(SECOND);
    press(tab(host, SECOND), "Home");
    expect(focused()).toBe("home");
    // Moving focus is not choosing: nothing switched.
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("closes the focused project tab on Delete or Backspace, but not Projects", () => {
    const { host, onClose } = renderView();
    press(tab(host, "home"), "Delete");
    press(tab(host, "home"), "Backspace");
    expect(onClose).not.toHaveBeenCalled();

    expect(press(tab(host, SECOND), "Delete")).toBe(false);
    expect(onClose).toHaveBeenLastCalledWith(SECOND);
    press(tab(host, OWN), "Backspace");
    expect(onClose).toHaveBeenLastCalledWith(OWN);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves other keys alone", () => {
    const { host, onClose, onActivate } = renderView();
    expect(press(tab(host, OWN), "a")).toBe(true);
    expect(press(tab(host, OWN), "ArrowDown")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps Studio's global shortcuts out of the strip (Delete would remove the selected clip)", () => {
    const { host } = renderView();
    expect(isTypingTarget(tab(host, OWN))).toBe(true);
    expect(isTypingTarget(closeButtons(host)[0])).toBe(true);
    expect(isTypingTarget(host.querySelector('button[aria-label="Open another project"]'))).toBe(
      true,
    );
  });

  it("is the 32 px row under the titlebar: only the empty remainder drags the window", () => {
    const { host } = renderView();
    const strip = host.querySelector<HTMLElement>('[data-testid="project-tab-strip"]');
    expect(strip?.className).toContain("h-head");
    expect(strip?.className).toContain("border-b");
    expect(strip?.className).toContain("bg-bg-1");
    expect(strip?.className).toContain("select-none");
    expect(host.querySelector('[role="tablist"]')?.hasAttribute("data-tauri-drag-region")).toBe(
      false,
    );
    expect(
      Array.from(host.querySelectorAll('[role="tab"], button')).some((el) =>
        el.hasAttribute("data-tauri-drag-region"),
      ),
    ).toBe(false);
    expect(strip?.lastElementChild?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });
});

describe("ProjectTabStrip", () => {
  interface Home {
    answer: unknown;
    requests: Array<{ method: string; path: string; body: unknown }>;
  }

  function stubHome(answer: unknown): Home {
    const state: Home = { answer, requests: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.slice(HOME.length);
        state.requests.push({
          method: init?.method ?? "GET",
          path,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        if (path === "/api/tabs") return { ok: true, json: async () => state.answer };
        if (path === "/api/tabs/close") return { ok: true, json: async () => ({ closed: true }) };
        return { ok: true, json: async () => ({ ok: true }) };
      }),
    );
    return state;
  }

  const enabledUrl = `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsChannel=beta&openvidsTab=${OWN}`;
  const flush = () =>
    act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

  it.each([
    ["the beta flag is off", `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsTab=${OWN}`],
    ["there is no tab key", `/?openvidsHome=${encodeURIComponent(HOME)}&openvidsChannel=beta`],
    ["it runs outside the desktop", `/?openvidsChannel=beta&openvidsTab=${OWN}`],
  ])("renders nothing, not even an empty box, when %s", async (_why, url) => {
    const home = stubHome({ enabled: true, active: "home", limit: 6, tabs: [] });
    window.history.replaceState(null, "", url);
    const host = render(<ProjectTabStrip />);
    await flush();
    expect(host.innerHTML).toBe("");
    expect(home.requests).toEqual([]);
  });

  it("renders nothing while the shell says tabs are off", async () => {
    stubHome({ enabled: false });
    window.history.replaceState(null, "", enabledUrl);
    const host = render(<ProjectTabStrip />);
    await flush();
    expect(host.innerHTML).toBe("");
  });

  it("draws the shell's tabs with the page's own one selected, and switches and closes through the shell", async () => {
    const home = stubHome({
      enabled: true,
      active: SECOND,
      limit: 6,
      tabs: [
        { key: OWN, name: "Alpha", state: "open" },
        { key: SECOND, name: "Beta", state: "open" },
      ],
    });
    window.history.replaceState(null, "", enabledUrl);
    const host = render(<ProjectTabStrip />);
    await flush();

    // `active` says Beta, but this page is only on screen while it is the active tab: its own is selected.
    expect(tab(host, OWN).getAttribute("aria-selected")).toBe("true");
    expect(tab(host, SECOND).getAttribute("aria-selected")).toBe("false");

    act(() => tab(host, SECOND).click());
    await flush();
    expect(home.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/tabs/activate",
      body: { key: SECOND },
    });

    home.requests.length = 0;
    act(() => closeButtons(host)[1].click());
    act(() => closeButtons(host)[1]?.click());
    await flush();
    const closes = home.requests.filter((request) => request.path === "/api/tabs/close");
    expect(closes).toEqual([{ method: "POST", path: "/api/tabs/close", body: { key: SECOND } }]);
  });
});
