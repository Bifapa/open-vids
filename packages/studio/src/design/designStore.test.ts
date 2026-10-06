import { describe, expect, it } from "vitest";
import type { ProjectDesignState } from "@hyperframes/agent-protocol";
import { DesignApiError } from "./designClient";
import { createDesignStore } from "./designStore";
import {
  NOTHING_ATTACHED,
  attachedDesign,
  attachedState,
  createFakeDesignClient,
  designSummary,
  type FakeDesignData,
} from "./designTestHarness";

function setup(data: FakeDesignData = {}) {
  const fake = createFakeDesignClient(data);
  const store = createDesignStore({ client: fake.client });
  return { ...fake, store };
}

describe("opening a project", () => {
  it("reads the library and what the project carries, with the palette and display font of its own copy", async () => {
    const { store, client } = setup({ state: attachedState() });
    await store.getState().open("demo");
    const { library, project } = store.getState();
    expect(library).toMatchObject({ status: "ready", systems: [{ id: "sunset" }], error: null });
    expect(project.status).toBe("ready");
    expect(project.state?.attached?.id).toBe("sunset");
    expect(project.facts).toEqual({
      palette: ["#0b0b0f", "#f4f1ea", "#ff6a3d", "#ffb347", "#4dd0e1"],
      displayFont: "Fraunces",
    });
    expect(client.getProject).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
    expect(client.snapshotTokens).toHaveBeenCalledTimes(1);
  });

  it("reads no tokens for a project with nothing attached or a damaged snapshot", async () => {
    const none = setup();
    await none.store.getState().open("demo");
    expect(none.store.getState().project).toMatchObject({ status: "ready", facts: null });
    expect(none.client.snapshotTokens).not.toHaveBeenCalled();

    const broken = setup({ state: attachedState({ snapshotOk: false }) });
    await broken.store.getState().open("demo");
    expect(broken.client.snapshotTokens).not.toHaveBeenCalled();
    expect(broken.store.getState().project.state?.snapshotOk).toBe(false);
  });

  it("keeps the attachment visible when only the swatches cannot be read", async () => {
    const { store, client } = setup({ state: attachedState() });
    client.snapshotTokens.mockRejectedValue(new DesignApiError("not_found", "gone", 404));
    await store.getState().open("demo");
    expect(store.getState().project).toMatchObject({ status: "ready", facts: null });
    expect(store.getState().project.state?.attached?.name).toBe("Sunset");
  });

  it("does not read again when the same project is opened twice", async () => {
    const { store, client } = setup();
    await store.getState().open("demo");
    await store.getState().open("demo");
    expect(client.getProject).toHaveBeenCalledTimes(1);
    expect(client.listLibrary).toHaveBeenCalledTimes(1);
  });
});

describe("attach, update and detach", () => {
  it("attaches with the right route, then reads the library and the project again", async () => {
    const { store, client } = setup();
    await store.getState().open("demo");
    client.getProject.mockClear();
    client.listLibrary.mockClear();

    expect(await store.getState().attach("sunset")).toBe(true);

    expect(client.attach).toHaveBeenCalledWith("demo", "sunset");
    expect(client.getProject).toHaveBeenCalledTimes(1);
    expect(client.listLibrary).toHaveBeenCalledTimes(1);
    const { project, mutation, notice } = store.getState();
    expect(project.state?.attached).toMatchObject({ id: "sunset", version: 2 });
    expect(project.facts?.displayFont).toBe("Fraunces");
    expect(mutation).toBeNull();
    expect(notice).toBeNull();
  });

  it("detaches with the right route and refreshes to an empty project", async () => {
    const { store, client } = setup({ state: attachedState() });
    await store.getState().open("demo");
    client.getProject.mockClear();

    expect(await store.getState().detach()).toBe(true);

    expect(client.detach).toHaveBeenCalledWith("demo");
    expect(client.getProject).toHaveBeenCalledTimes(1);
    expect(store.getState().project.state).toEqual(NOTHING_ATTACHED);
    expect(store.getState().project.facts).toBeNull();
  });

  it("updates only when asked, and the project then carries the library's current version", async () => {
    const { store, client, serverNow } = setup({ state: attachedState() });
    await store.getState().open("demo");
    serverNow({
      systems: [designSummary({ version: 3 })],
      state: attachedState({ library: { name: "Sunset", version: 3 }, updateAvailable: true }),
    });
    await store.getState().refresh();
    // Seeing the newer version changes nothing by itself.
    expect(store.getState().project.state).toMatchObject({ updateAvailable: true });
    expect(store.getState().project.state?.attached?.version).toBe(2);
    expect(client.update).not.toHaveBeenCalled();

    expect(await store.getState().update()).toBe(true);

    expect(client.update).toHaveBeenCalledWith("demo");
    expect(store.getState().project.state?.attached?.version).toBe(3);
    expect(store.getState().project.state?.updateAvailable).toBe(false);
  });

  it("says why an attach failed and still reads the library again", async () => {
    const { store, client, serverNow } = setup();
    await store.getState().open("demo");
    // Another window deleted the system after the list was read.
    serverNow({ systems: [] });
    client.listLibrary.mockClear();

    expect(await store.getState().attach("sunset")).toBe(false);

    expect(store.getState().notice).toEqual({
      message: "That system is gone.",
      issues: [],
    });
    expect(client.listLibrary).toHaveBeenCalledTimes(1);
    expect(store.getState().library.systems).toEqual([]);
    expect(store.getState().mutation).toBeNull();

    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it("runs one change at a time", async () => {
    const { store, client } = setup();
    await store.getState().open("demo");
    const gate = Promise.withResolvers<ProjectDesignState>();
    client.attach.mockImplementationOnce(() => gate.promise);

    const first = store.getState().attach("sunset");
    expect(store.getState().mutation).toEqual({ kind: "attach", id: "sunset" });
    expect(await store.getState().attach("sunset")).toBe(false);
    expect(await store.getState().detach()).toBe(false);
    expect(client.attach).toHaveBeenCalledTimes(1);

    gate.resolve(attachedState({ attached: attachedDesign() }));
    expect(await first).toBe(true);
    expect(store.getState().mutation).toBeNull();
  });
});

describe("loading and failing", () => {
  it("shows what is loading, and keeps the last answer when a refresh fails", async () => {
    const { store, client } = setup({ state: attachedState() });
    const opening = store.getState().open("demo");
    expect(store.getState()).toMatchObject({
      library: { status: "loading" },
      project: { status: "loading", state: null },
    });
    await opening;

    client.listLibrary.mockRejectedValueOnce(
      new DesignApiError("busy", "The library is busy.", 503),
    );
    client.getProject.mockRejectedValueOnce(new DesignApiError("network", "refused"));
    await store.getState().refresh();

    const { library, project } = store.getState();
    expect(library).toMatchObject({
      status: "error",
      error: "The library is busy.",
    });
    expect(library.systems).toHaveLength(1);
    expect(project.status).toBe("error");
    expect(project.error).toBe("refused");
    expect(project.state?.attached?.id).toBe("sunset");

    await store.getState().refresh();
    expect(store.getState().library).toMatchObject({ status: "ready", error: null });
    expect(store.getState().project).toMatchObject({ status: "ready", error: null });
  });

  it("drops the answer of a read that another project or a newer read replaced", async () => {
    const { store, client } = setup({ state: attachedState() });
    const late = Promise.withResolvers<ProjectDesignState>();
    client.getProject.mockImplementationOnce(() => late.promise);
    const first = store.getState().open("a");
    const second = store.getState().open("b");
    await second;
    expect(store.getState().projectId).toBe("b");
    expect(store.getState().project.state?.attached?.id).toBe("sunset");

    // Project a's slow answer arrives after b's: it must not overwrite b.
    late.resolve(NOTHING_ATTACHED);
    await first;
    expect(store.getState().projectId).toBe("b");
    expect(store.getState().project.state?.attached?.id).toBe("sunset");
  });

  it("aborts the read it supersedes", async () => {
    const { store, client } = setup();
    let signal: AbortSignal | undefined;
    client.getProject.mockImplementationOnce(async (_projectId, given) => {
      signal = given;
      return Promise.withResolvers<ProjectDesignState>().promise;
    });
    void store.getState().open("demo");
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    void store.getState().refresh();
    expect(signal?.aborted).toBe(true);
  });
});
