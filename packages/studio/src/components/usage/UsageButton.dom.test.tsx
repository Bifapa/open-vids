// @vitest-environment happy-dom

/**
 * The titlebar's agent-costs popover: the three ways it closes (outside press, Esc, a second press of its button), the
 * figures it shows (a missing cost is "tokens only", never zero; an incomplete total says so; Jev and Render QA sit
 * under their own heading) and that they follow a running turn.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UsageReport, UsageSlice, UsageTotals } from "@hyperframes/agent-protocol";
import { publishAgentTurnRunning } from "../../agent/agentTurnLock";
import { UsageButton } from "./UsageButton";
import { USAGE_LIVE_REFRESH_MS } from "./useProjectUsage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { getUsage } = vi.hoisted(() => ({ getUsage: vi.fn() }));
vi.mock("../../agent/agentClient", () => ({ createAgentClient: () => ({ getUsage }) }));

const totals = (tokens: number, cost: number | null): UsageTotals => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens,
  cost,
});
const slice = (tokens: number, cost: number | null, unpricedTokens = 0): UsageSlice => ({
  usage: totals(tokens, cost),
  unpricedTokens,
});

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    period: { since: null, until: null },
    total: slice(3_000, 1.5, 1_000),
    byAgent: [
      { agent: "director", internal: false, ...slice(1_500, 1.5) },
      { agent: "editor", internal: false, ...slice(500, null, 500) },
      { agent: "render_qa", internal: true, ...slice(1_000, null, 1_000) },
    ],
    byModel: [],
    byChat: [],
    live: false,
    ...overrides,
  };
}

let mounted: { root: Root; host: HTMLElement } | null = null;

function mount(): void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(<UsageButton projectId="demo" />));
}

const trigger = () => {
  const found = document.querySelector<HTMLElement>('[data-testid="header-usage"]');
  if (!found) throw new Error("usage button not rendered");
  return found;
};
const panel = () => document.querySelector('[data-testid="usage-panel"]');

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(target: Element): void {
  const init = { bubbles: true, cancelable: true, composed: true, detail: 1 };
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  });
}

async function open(): Promise<void> {
  click(trigger());
  await settle();
}

beforeEach(() => {
  getUsage.mockReset();
  getUsage.mockResolvedValue(report());
  publishAgentTurnRunning("demo", false);
});

afterEach(() => {
  vi.useRealTimers();
  publishAgentTurnRunning("demo", false);
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

describe("closing the popover", () => {
  it("is an icon button named for assistive tech, and opens under it without dimming anything", async () => {
    mount();
    expect(trigger().getAttribute("aria-label")).toBe("Agent costs");
    expect(trigger().textContent).toBe("");
    await open();
    expect(panel()).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Agent costs"]')).not.toBeNull();
  });

  it("closes on a press outside it", async () => {
    mount();
    await open();
    click(document.body);
    await settle();
    expect(panel()).toBeNull();
  });

  it("closes on Esc", async () => {
    mount();
    await open();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(panel()).toBeNull();
  });

  it("closes on a second press of its button", async () => {
    mount();
    await open();
    expect(panel()).not.toBeNull();
    click(trigger());
    await settle();
    expect(panel()).toBeNull();
  });
});

describe("the figures", () => {
  it("shows tokens only where no cost was reported, marks an incomplete total, and keeps internal runs apart", async () => {
    mount();
    await open();
    await settle();
    const total = document.querySelector('[data-testid="usage-total"]');
    expect(total?.textContent).toContain("≥ $1.50");
    expect(document.querySelector('[data-testid="usage-incomplete"]')).not.toBeNull();

    const rows = [...document.querySelectorAll('[data-testid="usage-row"]')].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Director");
    expect(rows[0]).toContain("$1.50");
    expect(rows[1]).toContain("Editor");
    expect(rows[1]).toContain("tokens only");
    expect(rows[1]).not.toContain("$0");
    const internal = document.querySelector('[data-testid="usage-rows"] h3');
    expect(internal?.textContent).toBe("Internal runs");
    expect(rows[2]).toContain("Render QA review");
  });

  it("reads tokens only for a total no provider priced, and says nothing is there when nothing was used", async () => {
    getUsage.mockResolvedValue(
      report({
        total: slice(900, null, 900),
        byAgent: [{ agent: "director", internal: false, ...slice(900, null, 900) }],
      }),
    );
    mount();
    await open();
    await settle();
    expect(document.querySelector('[data-testid="usage-total-cost"]')?.textContent).toBe(
      "tokens only",
    );
    expect(document.querySelector('[data-testid="usage-incomplete"]')).toBeNull();

    getUsage.mockResolvedValue(report({ total: slice(0, null), byAgent: [] }));
    click(trigger());
    await settle();
    await open();
    await settle();
    expect(panel()?.textContent).toContain("No agent usage in this period yet.");
  });

  it("re-reads while a turn runs and once more when it ends, and only while open", async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {
      publishAgentTurnRunning("demo", true);
    });
    await act(async () => {
      vi.advanceTimersByTime(USAGE_LIVE_REFRESH_MS * 3);
    });
    expect(getUsage).not.toHaveBeenCalled();

    click(trigger());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const first = getUsage.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_LIVE_REFRESH_MS * 2 + 10);
    });
    const running = getUsage.mock.calls.length;
    expect(running).toBeGreaterThanOrEqual(first + 2);

    await act(async () => {
      publishAgentTurnRunning("demo", false);
      await vi.advanceTimersByTimeAsync(50);
    });
    const ended = (getUsage as Mock).mock.calls.length;
    expect(ended).toBeGreaterThan(running);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_LIVE_REFRESH_MS * 3);
    });
    expect(getUsage.mock.calls.length).toBe(ended);
  });
});
