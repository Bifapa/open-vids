// @vitest-environment happy-dom

/**
 * The design surface's dialogs: "Create design system" starts a normal chat turn with the design action for each
 * source (and offers "another project" only when the host lists projects), the one-shot address parameter opens it,
 * "Edit with the agent" edits a library system, the preview frame runs no scripts, and the state is read again when
 * a turn ends. Nothing renders or reads the address with the beta flag off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiError } from "../agent/agentClient";
import {
  ACTIVE,
  CATALOG,
  chatState,
  createFakeClient,
  createSourceLog,
  type FakeClient,
} from "../agent/agentTestHarness";
import { createAgentStore, type AgentState, type AgentStore } from "../agent/agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import type * as designCreate from "./designCreate";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import type { DesignHostCapabilities } from "./designCreate";
import { DesignProvider } from "./designContext";
import { DesignHost } from "./DesignHost";
import { createDesignStore, type DesignStore } from "./designStore";
import {
  attachedState,
  createFakeDesignClient,
  designSummary,
  type FakeDesign,
  type FakeDesignData,
} from "./designTestHarness";
import {
  disableIframeLoading,
  byText,
  fieldByLabel,
  pressAndSettle,
  settle,
  typeInto,
  visitStudio,
} from "./designDom.testHelpers";
import { useDesignUi } from "./designUiStore";

const world = vi.hoisted(
  (): {
    files: string[];
    capabilities: { externalProjects: null | { key: string; name: string }[] };
  } => ({
    files: [],
    capabilities: { externalProjects: null },
  }),
);
vi.mock("../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => ({ fileTree: world.files }),
}));
vi.mock("./designCreate", async (importOriginal) => ({
  ...(await importOriginal<typeof designCreate>()),
  useDesignHostCapabilities: (): DesignHostCapabilities => world.capabilities,
}));

interface Mounted {
  host: HTMLElement;
  agent: AgentStore;
  agentClient: FakeClient;
  design: DesignStore;
  designClient: FakeDesign["client"];
}

function mountDesignHost(
  options: {
    agentState?: Partial<AgentState>;
    data?: FakeDesignData;
  } = {},
): Mounted {
  const agentClient = createFakeClient({ chat: chatState() });
  const sources = createSourceLog();
  const agent = createAgentStore({ client: agentClient, openEventSource: sources.open });
  agent.setState({
    availability: "ready",
    models: CATALOG,
    view: "chat",
    chatId: "c1",
    chat: chatState(),
    ...options.agentState,
  });
  const fake = createFakeDesignClient(options.data ?? { state: attachedState() });
  const design = createDesignStore({ client: fake.client });
  const host = mountHost(
    <DesignProvider store={design}>
      <DesignHost projectId="demo" agentStore={agent} />
    </DesignProvider>,
  );
  return { host, agent, agentClient, design, designClient: fake.client };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const startButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="design-create-start"]');
const sourceRadio = (value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="design-source"][value="${value}"]`);

async function chooseSource(value: string): Promise<void> {
  const radio = sourceRadio(value);
  if (!radio) throw new Error(`source ${value} is not offered`);
  await pressAndSettle(radio);
}

beforeEach(() => {
  visitStudio("beta");
  world.files = [];
  world.capabilities = { externalProjects: null };
  useDesignUi.setState({ dialog: null });
  useDockLayoutStore.setState({ pendingWorkspace: null, pendingActivation: null });
});

afterEach(() => {
  cleanupMounted();
  useDesignUi.setState({ dialog: null });
  useDockLayoutStore.setState({ pendingWorkspace: null, pendingActivation: null });
  visitStudio("");
});

describe("with the beta flag off", () => {
  it("renders nothing, leaves the address alone and reads nothing", async () => {
    window.history.replaceState(null, "", "/?openvidsDesign=create#project/demo");
    const { host, designClient } = mountDesignHost();
    await settle();
    expect(host.innerHTML).toBe("");
    expect(window.location.search).toBe("?openvidsDesign=create");
    expect(useDesignUi.getState().dialog).toBeNull();
    expect(designClient.getProject).not.toHaveBeenCalled();
  });
});

describe("the one-shot address parameter", () => {
  it("opens the create dialog on the source the Projects page chose and strips the parameters", async () => {
    window.history.replaceState(
      null,
      "",
      "/?openvidsChannel=beta&openvidsDesign=create&openvidsDesignSource=website#project/demo",
    );
    mountDesignHost();
    await settle();
    expect(dialog()?.textContent).toContain("Create design system");
    expect(sourceRadio("website")?.checked).toBe(true);
    expect(window.location.search).toBe("?openvidsChannel=beta");
    expect(window.location.hash).toBe("#project/demo");
  });

  it("opens on a brief when no source came with it", async () => {
    window.history.replaceState(null, "", "/?openvidsChannel=beta&openvidsDesign=create");
    mountDesignHost();
    await settle();
    expect(sourceRadio("scratch")?.checked).toBe(true);
  });
});

describe("starting a create turn", () => {
  async function openCreate(source: "scratch" | "project" | "video" | "website") {
    const mounted = mountDesignHost();
    useDesignUi.getState().openCreate(source);
    await settle();
    return mounted;
  }

  it("sends a brief as the prompt, with the design action and the brief source", async () => {
    const { agentClient, agent } = await openCreate("scratch");
    expect(startButton()?.disabled).toBe(true);
    await typeInto(fieldByLabel("Brief"), "A calm editorial look for a travel vlog");
    expect(startButton()?.disabled).toBe(false);

    await pressAndSettle(startButton());

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "A calm editorial look for a travel vlog",
        designAction: "create",
        designOptions: { source: "scratch" },
        userLanguage: "en",
      }),
    );
    // The dialog is done, and the chat is where the progress shows.
    expect(dialog()).toBeNull();
    expect(useDockLayoutStore.getState().pendingActivation).toBe("chat");
    expect(agent.getState().pending).toBeNull();
  });

  it("creates from this project with no further input, carrying optional notes", async () => {
    const { agentClient } = await openCreate("project");
    expect(startButton()?.disabled).toBe(false);
    await typeInto(fieldByLabel("Notes for the agent (optional)"), "Keep it warm");

    await pressAndSettle(startButton());

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Create a design system from this project.\n\nKeep it warm",
        designAction: "create",
        designOptions: { source: "project" },
      }),
    );
  });

  it("creates from a video of the project: the first video is chosen, and none is offered when there is none", async () => {
    world.files = [
      "index.html",
      "renders/old.mp4",
      "assets/promo.mp4",
      "assets/logo.png",
      "assets/b-roll.mov",
    ];
    const { agentClient } = await openCreate("video");
    expect(dialog()?.textContent).toContain("assets/promo.mp4");
    expect(dialog()?.textContent).not.toContain("renders/old.mp4");
    expect(startButton()?.disabled).toBe(false);

    await pressAndSettle(startButton());

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Create a design system from the video “assets/promo.mp4”.",
        designAction: "create",
        designOptions: { source: "video", video: "assets/promo.mp4" },
      }),
    );
  });

  it("cannot start from a video while the project has none", async () => {
    await openCreate("video");
    expect(dialog()?.textContent).toContain("This project has no videos yet");
    expect(startButton()?.disabled).toBe(true);
  });

  it("creates from a website: the address is checked, a bare host gets https, and the address goes into the prompt", async () => {
    const { agentClient } = await openCreate("website");
    expect(startButton()?.disabled).toBe(true);
    const address = fieldByLabel("Website address");

    await typeInto(address, "not an address");
    expect(startButton()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("Enter a web address like https://example.com.");

    await typeInto(address, "example.com/brand");
    expect(startButton()?.disabled).toBe(false);
    expect(dialog()?.textContent).not.toContain("Enter a web address");

    await pressAndSettle(startButton());

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Create a design system from the website https://example.com/brand.",
        designAction: "create",
        designOptions: { source: "website", url: "https://example.com/brand" },
      }),
    );
  });

  it("does not offer 'from another project' while the host reports no such capability", async () => {
    await openCreate("scratch");
    expect(
      [...document.querySelectorAll('input[name="design-source"]')].map((input) =>
        input.getAttribute("value"),
      ),
    ).toEqual(["scratch", "project", "video", "website"]);
    expect(dialog()?.textContent).not.toContain("From another project");
  });

  it("offers 'from another project' when the host lists projects, and sends the chosen project's key", async () => {
    world.capabilities = { externalProjects: [{ key: "k-1", name: "Summer trip" }] };
    const { agentClient } = await openCreate("scratch");
    expect(dialog()?.textContent).toContain("From another project");

    await chooseSource("external_project");
    expect(startButton()?.disabled).toBe(false);
    await pressAndSettle(startButton());

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Create a design system from the project “Summer trip”.",
        designAction: "create",
        designOptions: { source: "external_project", projectKey: "k-1" },
      }),
    );
  });

  it("switches the source with the radio group and keeps what each source needs", async () => {
    await openCreate("scratch");
    expect(dialog()?.textContent).toContain("Brief");
    await chooseSource("website");
    expect(dialog()?.textContent).toContain("Website address");
    expect(dialog()?.textContent).not.toContain("What it is for");
    await chooseSource("project");
    expect(dialog()?.textContent).toContain("Notes for the agent (optional)");
    expect(byText(document, "button", "Create design system")).not.toBeNull();
  });

  it("opens a new chat when none is open, and starts the turn in it", async () => {
    const { agentClient, agent } = mountDesignHost({
      agentState: { chatId: null, chat: null, view: "history" },
    });
    useDesignUi.getState().openCreate("project");
    await settle();

    await pressAndSettle(startButton());

    expect(agentClient.createChat).toHaveBeenCalledTimes(1);
    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "new",
      expect.objectContaining({ designAction: "create" }),
    );
    expect(agent.getState().chatId).toBe("new");
  });

  it("stays open and says why when the agent cannot take the turn", async () => {
    const { agentClient } = mountDesignHost();
    agentClient.startTurn.mockRejectedValueOnce(
      new AgentApiError("project_busy", "Another chat is running.", 409),
    );
    useDesignUi.getState().openCreate("project");
    await settle();

    await pressAndSettle(startButton());

    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent?.length).toBeGreaterThan(0);
    expect(useDockLayoutStore.getState().pendingActivation).toBeNull();
    expect(startButton()?.disabled).toBe(false);
  });

  it("cannot start while the agent is unavailable or already working, and says which", async () => {
    mountDesignHost({ agentState: { availability: "unavailable" } });
    useDesignUi.getState().openCreate("project");
    await settle();
    expect(startButton()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("The agent is unavailable");
    cleanupMounted();
    useDesignUi.setState({ dialog: null });

    const { agentClient } = mountDesignHost({ agentState: { activeTurn: ACTIVE } });
    useDesignUi.getState().openCreate("project");
    await settle();
    expect(startButton()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("The agent is working");
    expect(agentClient.startTurn).not.toHaveBeenCalled();
  });
});

describe("editing a library system with the agent", () => {
  it("sends the instruction as an edit of that system", async () => {
    const { agentClient } = mountDesignHost({
      data: { systems: [designSummary()], state: attachedState() },
    });
    useDesignUi.getState().openEdit("sunset");
    await settle();
    expect(dialog()?.textContent).toContain("Edit “Sunset”");
    const start = document.querySelector<HTMLButtonElement>('[data-testid="design-edit-start"]');
    expect(start?.disabled).toBe(true);

    await typeInto(fieldByLabel("What should change?"), "Make the accent warmer");
    await pressAndSettle(start);

    expect(agentClient.startTurn).toHaveBeenCalledExactlyOnceWith(
      "c1",
      expect.objectContaining({
        prompt: "Make the accent warmer",
        designAction: "edit",
        designOptions: { systemId: "sunset" },
      }),
    );
    expect(dialog()).toBeNull();
    expect(useDockLayoutStore.getState().pendingActivation).toBe("chat");
  });
});

describe("the preview", () => {
  // happy-dom would fetch the frame's `src` for real; with loading off it only prints that it skipped it.
  beforeEach(disableIframeLoading);

  it("shows the project's snapshot in a frame that allows nothing", async () => {
    mountDesignHost();
    useDesignUi.getState().openPreview({ kind: "project", projectId: "demo" }, "Sunset");
    await settle();
    const frame = document.querySelector<HTMLIFrameElement>("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.sandbox.contains("allow-scripts")).toBe(false);
    expect(frame?.sandbox.contains("allow-same-origin")).toBe(false);
    expect(frame?.getAttribute("src")).toBe("/api/projects/demo/design/files/system.html");
    expect(frame?.getAttribute("title")).toBe("Preview of Sunset");
  });

  it("shows a library system's current version the same way", async () => {
    mountDesignHost();
    useDesignUi.getState().openPreview({ kind: "library", id: "mono", version: 4 }, "Mono");
    await settle();
    const frame = document.querySelector<HTMLIFrameElement>("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("src")).toBe("/api/design-systems/mono/files/system.html?version=4");
  });
});

describe("keeping in step with the agent", () => {
  it("reads the library and the project again when a turn ends, and not when one starts", async () => {
    const { agent, designClient } = mountDesignHost({ agentState: { activeTurn: ACTIVE } });
    await settle();
    const reads = designClient.getProject.mock.calls.length;

    agent.setState({ activeTurn: null });
    await settle();
    expect(designClient.getProject.mock.calls.length).toBe(reads + 1);

    agent.setState({ activeTurn: ACTIVE });
    await settle();
    expect(designClient.getProject.mock.calls.length).toBe(reads + 1);
  });
});
