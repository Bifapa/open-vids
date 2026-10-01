// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { EXECUTION_BUDGETS, type ExecutionQuality } from "@hyperframes/agent-protocol";
import { SETTINGS, chatState, runningChatState, summary } from "../../agent/agentTestHarness";
import {
  buttonWithText,
  byLabel,
  click,
  mountChat,
  pressKey,
  type,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

/** Base UI opens popups a task after the click. */
async function settle() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

const trigger = () =>
  document.body.querySelector<HTMLButtonElement>('button[aria-label^="Execution quality:"]');
const row = (name: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-quality-row="${name}"]`);

async function openMenu() {
  await click(trigger());
  await settle();
  if (!row("fast")) throw new Error("the quality menu did not open");
}

function radio(group: string, value: string): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(
    `[role="radiogroup"][aria-label="${group}"] input[value="${value}"]`,
  );
  if (!input) throw new Error(`no ${group} choice ${value}`);
  return input;
}

it("shows that a chat follows the global default, switches to a preset and back to the default", async () => {
  mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState(), settings: SETTINGS });
  const { client } = mounted;

  expect(trigger()?.getAttribute("aria-label")).toBe("Execution quality: Balanced (default)");

  await openMenu();
  expect(row("default")?.getAttribute("aria-checked")).toBe("true");
  expect(row("default")?.textContent).toContain("Default · Balanced");
  expect(row("default")?.textContent).toContain("2 render QA passes");
  // Each preset says what it changes, from the shared budgets.
  expect(row("fast")?.textContent).toContain(
    "1 render QA pass · Vision 6 frames/min, max 12 · 1 critique round · 4 research candidates · light specialist thinking",
  );
  expect(row("best")?.textContent).toContain("3 render QA passes");
  expect(row("best")?.textContent).toContain("deep specialist thinking");

  await click(row("fast"));
  // Choosing a preset keeps the custom budget, so Custom later restores it.
  expect(client.updateChat).toHaveBeenLastCalledWith("c1", {
    executionQuality: { preset: "fast", custom: EXECUTION_BUDGETS.balanced },
  });
  expect(trigger()?.getAttribute("aria-label")).toBe("Execution quality: Fast");

  await openMenu();
  expect(row("fast")?.getAttribute("aria-checked")).toBe("true");
  await click(row("default"));
  expect(client.updateChat).toHaveBeenLastCalledWith("c1", { executionQuality: null });
  expect(trigger()?.getAttribute("aria-label")).toBe("Execution quality: Balanced (default)");
});

it("edits a custom budget within its ranges and saves it for the chat", async () => {
  const own: ExecutionQuality = {
    preset: "best",
    custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 4 },
  };
  mounted = mountChat({
    view: "chat",
    chatId: "c1",
    chat: chatState({ chat: summary({ executionQuality: own }) }),
    settings: SETTINGS,
  });
  const { client } = mounted;
  expect(trigger()?.getAttribute("aria-label")).toBe("Execution quality: Best");

  await openMenu();
  expect(row("custom")?.textContent).toContain("4 render QA passes");
  await click(row("custom"));
  await settle();

  // The editor starts from the chat's own custom budget.
  expect(radio("Render QA passes", "4").checked).toBe(true);
  await click(radio("Render QA passes", "0"));
  expect(document.body.textContent).toContain("Render QA is off");

  const candidates = byLabel<HTMLInputElement>(document.body, "Research candidates");
  if (!candidates) throw new Error("no research candidates field");
  await type(candidates, "99");
  await pressKey(candidates, "Enter");
  await click(radio("Specialist thinking", "thorough"));

  await click(buttonWithText(document.body, "Save"));
  expect(client.updateChat).toHaveBeenLastCalledWith("c1", {
    executionQuality: {
      preset: "custom",
      // 99 is held to the range's top.
      custom: {
        ...EXECUTION_BUDGETS.fast,
        qaPasses: 0,
        researchCandidates: 24,
        specialistThinking: "thorough",
      },
    },
  });
  expect(trigger()?.getAttribute("aria-label")).toBe("Execution quality: Custom");
});

it("locks the choice while the chat is working", async () => {
  mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState(), settings: SETTINGS });
  await openMenu();
  expect(row("fast")?.disabled).toBe(true);
  expect(row("custom")?.disabled).toBe(true);
  expect(document.body.textContent).toContain("Can't change while the agent is working");
});
