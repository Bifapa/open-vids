// @vitest-environment happy-dom

/**
 * What a design turn looks like in the chat: a «Design system · create/edit» tag on its prompt, and under a finished
 * turn that saved a system a card with one click to attach it (or update the project's older copy). Retrying a
 * failed design turn carries its action and options.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AssistantPart,
  ChatState,
  DesignAction,
  DesignActionOptions,
  TurnStatus,
} from "@hyperframes/agent-protocol";
import { AgentStoreProvider } from "../../agent/agentContext";
import { createAgentStore } from "../../agent/agentStore";
import {
  CATALOG,
  assistantMessage,
  chatState,
  createFakeClient,
  createSourceLog,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { DesignApiError } from "../../design/designClient";
import { DesignProvider } from "../../design/designContext";
import { createDesignStore } from "../../design/designStore";
import {
  attachedDesign,
  attachedState,
  createFakeDesignClient,
  designSummary,
  type FakeDesignData,
} from "../../design/designTestHarness";
import { settle } from "../../design/designDom.testHelpers";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { AgentChatBody } from "./AgentChatPanel";
import { buttonWithText, click } from "./chatTestHarness";

function savedPart(
  status: "done" | "failed" | "running",
  params: Record<string, string> = { id: "sunset", name: "Sunset" },
): AssistantPart {
  return {
    type: "activity",
    id: `a-${params.id}`,
    activity: {
      id: `act-${params.id}`,
      category: "edit",
      status,
      label: "Saving design system",
      labelCode: "saving_design_system",
      labelParams: params,
      count: 1,
      targets: [],
      startedAt: 3000,
    },
  };
}

/** A chat with one design turn: its prompt, the agent's reply (with `parts`) and the turn's end state. */
function designChat(options: {
  status?: TurnStatus;
  action?: DesignAction;
  designOptions?: DesignActionOptions;
  parts?: AssistantPart[];
}): ChatState {
  const status = options.status ?? "completed";
  const action = options.action ?? "create";
  return chatState({
    chat: summary({ status: status === "failed" ? "failed" : "completed" }),
    messages: [
      userMessage("m1", "Create a design system from this project."),
      assistantMessage({
        status: status === "running" ? "streaming" : status === "failed" ? "failed" : "complete",
        parts: options.parts ?? [],
      }),
    ],
    turns: [
      turn({
        status,
        endedAt: status === "running" ? undefined : 9000,
        checkpoint: null,
        designAction: action,
        designOptions: options.designOptions ?? { source: "project" },
        ...(status === "failed" && { error: { code: "provider_overloaded", message: "529" } }),
      }),
    ],
    lastSeq: 5,
  });
}

async function open(chat: ChatState, design: FakeDesignData = {}) {
  const agentClient = createFakeClient({ chat });
  const agent = createAgentStore({ client: agentClient, openEventSource: createSourceLog().open });
  agent.setState({
    availability: "ready",
    models: CATALOG,
    view: "chat",
    chatId: chat.chat.id,
    chat,
  });
  const fake = createFakeDesignClient(design);
  const store = createDesignStore({ client: fake.client });
  await store.getState().open("demo");
  const host = mountHost(
    <DesignProvider store={store}>
      <AgentStoreProvider store={agent}>
        <AgentChatBody />
      </AgentStoreProvider>
    </DesignProvider>,
  );
  await settle();
  return { host, agentClient, designClient: fake.client, store };
}

const card = () => document.querySelector<HTMLElement>('[data-testid="design-saved-card"]');
const tag = () => document.querySelector<HTMLElement>('[data-testid="design-turn-tag"]');

afterEach(() => {
  cleanupMounted();
});

describe("the tag on a design prompt", () => {
  it("names the action: create or edit", async () => {
    await open(designChat({ action: "create" }));
    expect(tag()?.textContent).toBe("Design system · create");
    cleanupMounted();

    await open(designChat({ action: "edit", designOptions: { systemId: "sunset" } }));
    expect(tag()?.textContent).toBe("Design system · edit");
  });

  it("is not on an ordinary prompt", async () => {
    const chat = chatState({
      messages: [userMessage("m1", "Trim the intro"), assistantMessage({ status: "complete" })],
      turns: [turn({ status: "completed", checkpoint: null })],
    });
    await open(chat);
    expect(tag()).toBeNull();
  });
});

describe("the card under a turn that saved a system", () => {
  it("offers one click to attach it, and attaching puts it on the project", async () => {
    const { host, designClient } = await open(designChat({ parts: [savedPart("done")] }));
    expect(card()?.textContent).toContain("Saved “Sunset” to your library");
    expect(card()?.textContent).toContain("No composition changes");
    expect(designClient.attach).not.toHaveBeenCalled();

    await click(buttonWithText(card() ?? host, "Attach to this project"));
    await settle();

    expect(designClient.attach).toHaveBeenCalledExactlyOnceWith("demo", "sunset");
    expect(card()?.textContent).toContain("Attached to this project (v2).");
    expect(buttonWithText(card() ?? host, "Attach to this project")).toBeNull();
  });

  it("says it is attached already, and offers an explicit update when the project holds an older version", async () => {
    await open(designChat({ parts: [savedPart("done")] }), {
      systems: [designSummary()],
      state: attachedState(),
    });
    expect(card()?.textContent).toContain("Attached to this project (v2).");
    expect(card()?.querySelector("button")).toBeNull();
    cleanupMounted();

    const { host, designClient } = await open(designChat({ parts: [savedPart("done")] }), {
      systems: [designSummary({ version: 3 })],
      state: attachedState({
        attached: attachedDesign({ version: 2 }),
        library: { name: "Sunset", version: 3 },
        updateAvailable: true,
      }),
    });
    expect(card()?.textContent).toContain("This project still has v2; your library now has v3.");
    expect(designClient.update).not.toHaveBeenCalled();

    await click(buttonWithText(card() ?? host, "Update design system to v3"));
    await settle();

    expect(designClient.update).toHaveBeenCalledExactlyOnceWith("demo");
    expect(card()?.textContent).toContain("Attached to this project (v3).");
  });

  it("attaches a different system than the one the project has, replacing it", async () => {
    const { host, designClient } = await open(
      designChat({ parts: [savedPart("done", { id: "mono", name: "Mono" })] }),
      {
        systems: [designSummary(), designSummary({ id: "mono", name: "Mono", version: 1 })],
        state: attachedState(),
      },
    );
    await click(buttonWithText(card() ?? host, "Attach to this project"));
    await settle();
    expect(designClient.attach).toHaveBeenCalledWith("demo", "mono");
  });

  it("shows a failed Attach only on the card whose button was pressed, and nothing for a failure from elsewhere", async () => {
    const { designClient, store } = await open(
      designChat({
        parts: [savedPart("done"), savedPart("done", { id: "mono", name: "Mono" })],
      }),
      { systems: [designSummary(), designSummary({ id: "mono", name: "Mono", version: 1 })] },
    );
    const cardOf = (name: string) =>
      document.querySelector<HTMLElement>(`[aria-label="Saved design system ${name}"]`);
    const alertOf = (name: string) => cardOf(name)?.querySelector('[role="alert"]') ?? null;
    designClient.attach.mockRejectedValueOnce(
      new DesignApiError("busy", "The library is busy.", 503),
    );

    await click(buttonWithText(cardOf("Mono") ?? document.body, "Attach to this project"));
    await settle();
    expect(alertOf("Mono")?.textContent).toBe("The library is busy.");
    expect(alertOf("Sunset")).toBeNull();

    // The popover's own Detach failing is neither card's failure.
    designClient.detach.mockRejectedValueOnce(
      new DesignApiError("busy", "The library is busy.", 503),
    );
    await act(async () => {
      await store.getState().detach();
    });
    expect(store.getState().notice?.mutation).toEqual({ kind: "detach" });
    expect(alertOf("Mono")).toBeNull();
    expect(alertOf("Sunset")).toBeNull();
  });

  it("shows a failed Update on the card that offers it, not on a card that offers Attach", async () => {
    const { designClient } = await open(
      designChat({
        parts: [savedPart("done"), savedPart("done", { id: "mono", name: "Mono" })],
      }),
      {
        systems: [
          designSummary({ version: 3 }),
          designSummary({ id: "mono", name: "Mono", version: 1 }),
        ],
        state: attachedState({
          attached: attachedDesign({ version: 2 }),
          library: { name: "Sunset", version: 3 },
          updateAvailable: true,
        }),
      },
    );
    const cardOf = (name: string) =>
      document.querySelector<HTMLElement>(`[aria-label="Saved design system ${name}"]`);
    designClient.update.mockRejectedValueOnce(
      new DesignApiError("conflict", "Nothing newer.", 409),
    );

    await click(buttonWithText(cardOf("Sunset") ?? document.body, "Update design system to v3"));
    await settle();

    expect(cardOf("Sunset")?.querySelector('[role="alert"]')?.textContent).toBe("Nothing newer.");
    expect(cardOf("Mono")?.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers Replace on the card when the library's system of that name is a different one", async () => {
    const { host, designClient } = await open(designChat({ parts: [savedPart("done")] }), {
      systems: [designSummary({ version: 1 })],
      state: attachedState({
        attached: attachedDesign({ version: 3 }),
        library: { name: "Sunset", version: 1 },
        updateAvailable: true,
      }),
    });
    expect(card()?.textContent).toContain("different system");
    await click(buttonWithText(card() ?? host, "Replace with the library's v1"));
    await settle();
    expect(designClient.update).toHaveBeenCalledExactlyOnceWith("demo");
  });

  it("uses the system an edit turn was asked to change, whatever the agent passed", async () => {
    const { host, designClient } = await open(
      designChat({
        action: "edit",
        designOptions: { systemId: "sunset" },
        parts: [savedPart("done", { id: "other", name: "Sunset" })],
      }),
    );
    await click(buttonWithText(card() ?? host, "Attach to this project"));
    await settle();
    expect(designClient.attach).toHaveBeenCalledWith("demo", "sunset");
  });

  it("shows nothing for a save that failed, for a turn still running and for a turn that saved nothing", async () => {
    await open(designChat({ parts: [savedPart("failed")] }));
    expect(card()).toBeNull();
    cleanupMounted();

    await open(designChat({ status: "running", parts: [savedPart("done")] }));
    expect(card()).toBeNull();
    cleanupMounted();

    await open(designChat({ parts: [] }));
    expect(card()).toBeNull();
  });
});

describe("retrying a failed design turn", () => {
  it("starts it again as the same design action with the same options", async () => {
    const { host, agentClient } = await open(
      designChat({
        status: "failed",
        designOptions: { source: "website", url: "https://example.com" },
      }),
    );
    await click(buttonWithText(host, "Retry this turn"));
    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Create a design system from this project.",
        designAction: "create",
        designOptions: { source: "website", url: "https://example.com" },
      }),
    );
  });
});
