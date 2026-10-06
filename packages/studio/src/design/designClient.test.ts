import { describe, expect, it, vi } from "vitest";
import { DesignApiError, createDesignClient, designPreviewUrl } from "./designClient";
import { NOTHING_ATTACHED, attachedState, designSummary } from "./designTestHarness";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A client over a fetch that answers `respond`; returns the calls it saw as [url, method, body]. */
function clientOver(respond: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => respond());
  const seen = () =>
    fetchImpl.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET", init?.body]);
  return { client: createDesignClient(fetchImpl), seen };
}

describe("the design client's routes", () => {
  it("reads the library and the project's state with GET", async () => {
    const library = clientOver(() => json({ systems: [designSummary()] }));
    expect(await library.client.listLibrary()).toEqual([designSummary()]);
    expect(library.seen()).toEqual([["/api/design-systems", "GET", undefined]]);

    const project = clientOver(() => json(NOTHING_ATTACHED));
    expect(await project.client.getProject("demo")).toEqual(NOTHING_ATTACHED);
    expect(project.seen()).toEqual([["/api/projects/demo/design", "GET", undefined]]);
  });

  it("attaches with PUT {id}, updates with POST and detaches with DELETE", async () => {
    const attached = attachedState();
    const { client, seen } = clientOver(() => json(attached));
    await client.attach("demo", "sunset");
    await client.update("demo");
    await client.detach("demo");
    expect(seen()).toEqual([
      ["/api/projects/demo/design", "PUT", JSON.stringify({ id: "sunset" })],
      ["/api/projects/demo/design/update", "POST", undefined],
      ["/api/projects/demo/design", "DELETE", undefined],
    ]);
  });

  it("reads the snapshot's own tokens.css as text, and escapes the project id", async () => {
    const { client, seen } = clientOver(() => new Response(":root{--bg:#000;}"));
    expect(await client.snapshotTokens("My Project")).toBe(":root{--bg:#000;}");
    expect(seen()).toEqual([
      ["/api/projects/My%20Project/design/files/tokens.css", "GET", undefined],
    ]);
  });
});

describe("the design client's failures", () => {
  it("turns the server's error code into plain wording and keeps its list of problems", async () => {
    const { client } = clientOver(() =>
      json({ error: { code: "invalid_system", message: "raw", issues: ["missing --bg"] } }, 422),
    );
    const failure = await client.attach("demo", "sunset").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesignApiError);
    expect(failure).toMatchObject({
      code: "invalid_system",
      status: 422,
      issues: ["missing --bg"],
      message: "The design system's files don't pass the format check.",
    });
  });

  it("tells a vanished system, a dead server, an unreadable answer and a wrong shape apart", async () => {
    const gone = clientOver(() => json({ error: { code: "not_found", message: "x" } }, 404));
    await expect(gone.client.attach("demo", "sunset")).rejects.toMatchObject({
      code: "not_found",
      message: "That design system is no longer in your library.",
    });

    const crashed = clientOver(() => new Response("oops", { status: 500 }));
    await expect(crashed.client.getProject("demo")).rejects.toMatchObject({
      code: "http",
      status: 500,
      message: "The design service answered with status 500.",
    });

    const down = createDesignClient(() => Promise.reject(new Error("refused")));
    await expect(down.getProject("demo")).rejects.toMatchObject({ code: "network" });

    const odd = clientOver(() => json({ systems: "none" }));
    await expect(odd.client.listLibrary()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reports an aborted read as aborted, not as a network failure", async () => {
    const controller = new AbortController();
    const client = createDesignClient((_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      return promise;
    });
    const pending = client.getProject("demo", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("designPreviewUrl", () => {
  it("points at the project's snapshot or at a library system's showcase page", () => {
    expect(designPreviewUrl({ kind: "project", projectId: "demo" })).toBe(
      "/api/projects/demo/design/files/system.html",
    );
    expect(designPreviewUrl({ kind: "library", id: "sunset" })).toBe(
      "/api/design-systems/sunset/files/system.html",
    );
    expect(designPreviewUrl({ kind: "library", id: "sunset", version: 3 })).toBe(
      "/api/design-systems/sunset/files/system.html?version=3",
    );
  });
});
