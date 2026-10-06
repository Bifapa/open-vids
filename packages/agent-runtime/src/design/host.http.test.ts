// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectScope } from "../checkpointHost.js";
import {
  NO_DESIGN,
  sampleManifest,
  sampleSpec,
  summaryOf,
  systemDetail,
} from "../testing/design.js";
import { DesignToolError } from "./host.js";
import { HttpDesignHost } from "./host.http.js";

interface Seen {
  method: string;
  path: string;
  body: unknown;
  contentType: string | undefined;
}

type Route = (request: Seen, response: ServerResponse) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const text = (response: ServerResponse, body: string) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(body);
};

const PROJECT = "/api/projects/p%201/design";
const LIBRARY = "/api/design-systems";

/** A loopback stand-in for Studio's design routes: `routes` is keyed by "METHOD /path-without-query". */
async function studio(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      const record: Seen = {
        method: request.method ?? "GET",
        path: url,
        body: body ? JSON.parse(body) : null,
        contentType: request.headers["content-type"],
      };
      seen.push(record);
      const route = routes[`${record.method} ${url.split("?")[0]}`];
      if (route) route(record, response);
      else json(response, 404, { error: { code: "not_found", message: `no route ${url}` } });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const scope: ProjectScope = {
    projectId: "p 1",
    projectDir: "/tmp/p",
    studioOrigin: `http://127.0.0.1:${address.port}`,
  };
  return { host: new HttpDesignHost(scope), seen, scope };
}

const signal = () => new AbortController().signal;

const attached = {
  schema: "openvids.project-design/1",
  id: "acme",
  version: 2,
  name: "Acme",
  attachedAt: 5,
  unknownLicenses: [],
  nonPortableFonts: [],
} as const;

describe("HttpDesignHost routes", () => {
  it("uses the documented routes, methods and bodies", async () => {
    const detail = systemDetail("acme", { name: "Acme", version: 2 });
    const state = {
      attached,
      library: { name: "Acme", version: 2 },
      updateAvailable: false,
      snapshotOk: true,
    };
    const extraction = {
      files: ["index.html"],
      colors: [{ value: "#ff5a36", count: 3, roles: ["fill"] }],
      fonts: [],
      easings: [],
      durations: [],
      radii: [],
      fontSizes: [],
      shadows: [],
      declaredTokens: {},
    };
    const palette = {
      video: "assets/my clip.mp4",
      durationSec: 9,
      samples: 6,
      colors: [{ value: "#101820", share: 0.5 }],
    };
    const { host, seen } = await studio({
      [`GET ${LIBRARY}`]: (_request, response) =>
        json(response, 200, { systems: [summaryOf("acme"), summaryOf("beta")] }),
      [`GET ${LIBRARY}/acme`]: (_request, response) => json(response, 200, detail),
      [`PUT ${LIBRARY}/acme`]: (_request, response) =>
        json(response, 200, { system: summaryOf("acme", { version: 3 }), notes: ["downloaded"] }),
      [`GET ${PROJECT}/extract`]: (_request, response) => json(response, 200, extraction),
      [`GET ${PROJECT}/video-palette`]: (_request, response) => json(response, 200, palette),
      [`GET ${PROJECT}`]: (_request, response) => json(response, 200, state),
      [`PUT ${PROJECT}`]: (_request, response) => json(response, 200, state),
    });

    expect((await host.list(signal())).map((system) => system.id)).toEqual(["acme", "beta"]);
    expect((await host.get("acme", undefined, signal())).version).toBe(2);
    await host.get("acme", 1, signal());
    const saved = await host.save(
      "acme",
      {
        name: "Acme",
        source: { kind: "scratch" },
        spec: sampleSpec(),
        baseVersion: 2,
        projectId: "p 1",
      },
      signal(),
    );
    expect(saved.notes).toEqual(["downloaded"]);
    expect((await host.extract(signal())).colors[0]?.value).toBe("#ff5a36");
    expect((await host.videoPalette("assets/my clip.mp4", 6, signal())).samples).toBe(6);
    await host.videoPalette("assets/a.mp4", undefined, signal());
    expect((await host.projectState(signal())).attached?.id).toBe("acme");
    await host.attach("acme", signal());

    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${LIBRARY}`,
      `GET ${LIBRARY}/acme`,
      `GET ${LIBRARY}/acme?version=1`,
      `PUT ${LIBRARY}/acme`,
      `GET ${PROJECT}/extract`,
      `GET ${PROJECT}/video-palette?video=assets%2Fmy+clip.mp4&samples=6`,
      `GET ${PROJECT}/video-palette?video=assets%2Fa.mp4`,
      `GET ${PROJECT}`,
      `PUT ${PROJECT}`,
    ]);
    expect(seen[3]?.contentType).toBe("application/json");
    expect(seen[3]?.body).toMatchObject({ name: "Acme", baseVersion: 2, projectId: "p 1" });
    expect(seen[8]?.body).toEqual({ id: "acme" });
  });

  it("reads the project's snapshot: the attach record, its tokens and its manifest", async () => {
    const manifest = sampleManifest({
      version: 2,
      guesses: ["font Inter is a guess"],
      summary: "Bold.",
    });
    const html = `<!doctype html><style>:root{--bg:#000}</style><script type="application/json" id="openvids-design-manifest">${JSON.stringify(manifest)}</script>`;
    const css =
      ':root { --bg: #0b0b10; --brand: #ff5a36; --font-display: "Inter", sans-serif; }\n@font-face { font-family: Inter; src: url(fonts/a.woff2); }';
    const { host, seen } = await studio({
      [`GET ${PROJECT}`]: (_request, response) =>
        json(response, 200, {
          attached,
          library: { name: "Acme", version: 3 },
          updateAvailable: true,
          snapshotOk: true,
        }),
      [`GET ${PROJECT}/files/tokens.css`]: (_request, response) => text(response, css),
      [`GET ${PROJECT}/files/system.html`]: (_request, response) => text(response, html),
    });
    const snapshot = await host.snapshot(signal());
    expect(snapshot.state.updateAvailable).toBe(true);
    expect(snapshot.tokens).toEqual({
      "--bg": "#0b0b10",
      "--brand": "#ff5a36",
      "--font-display": '"Inter", sans-serif',
    });
    expect(snapshot.manifest?.guesses).toEqual(["font Inter is a guess"]);
    expect(seen).toHaveLength(3);
  });

  it("does not read files when nothing is attached or the snapshot is damaged, and survives a missing file", async () => {
    const none = await studio({
      [`GET ${PROJECT}`]: (_request, response) => json(response, 200, NO_DESIGN),
    });
    expect(await none.host.snapshot(signal())).toEqual({
      state: NO_DESIGN,
      tokens: null,
      manifest: null,
    });
    expect(none.seen).toHaveLength(1);

    const damaged = await studio({
      [`GET ${PROJECT}`]: (_request, response) =>
        json(response, 200, { ...NO_DESIGN, attached, snapshotOk: false }),
    });
    expect((await damaged.host.snapshot(signal())).tokens).toBeNull();
    expect(damaged.seen).toHaveLength(1);

    const partial = await studio({
      [`GET ${PROJECT}`]: (_request, response) =>
        json(response, 200, { ...NO_DESIGN, attached, snapshotOk: true }),
      [`GET ${PROJECT}/files/tokens.css`]: (_request, response) =>
        text(response, ":root{--bg:#000}"),
    });
    const snapshot = await partial.host.snapshot(signal());
    expect(snapshot.tokens).toEqual({ "--bg": "#000" });
    expect(snapshot.manifest).toBeNull();
  });
});

describe("HttpDesignHost failures", () => {
  it("turns the service's DesignError into a DesignToolError with every issue", async () => {
    const { host } = await studio({
      [`PUT ${LIBRARY}/acme`]: (_request, response) =>
        json(response, 422, {
          error: {
            code: "invalid_system",
            message: "The system is not valid.",
            issues: ["--bg is missing", "font Inter has no files"],
          },
        }),
    });
    const failure = await host
      .save("acme", { name: "Acme", source: { kind: "scratch" }, spec: sampleSpec() }, signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesignToolError);
    expect(failure).toMatchObject({
      code: "invalid_system",
      message: "The system is not valid.",
      issues: ["--bg is missing", "font Inter has no files"],
    });
  });

  it("maps a missing system, a plain-text failure, an invalid answer and an unreachable server", async () => {
    const { host } = await studio({
      [`GET ${LIBRARY}/broken`]: (_request, response) => json(response, 200, { id: "broken" }),
      [`GET ${LIBRARY}/boom`]: (_request, response) => {
        response.writeHead(500);
        response.end("boom");
      },
    });
    await expect(host.get("gone", undefined, signal())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(host.get("broken", undefined, signal())).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("invalid design system"),
    });
    await expect(host.get("boom", undefined, signal())).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("(500)"),
    });

    const closed = new HttpDesignHost({
      projectId: "p",
      projectDir: "/tmp/p",
      studioOrigin: "http://127.0.0.1:1",
    });
    await expect(closed.list(signal())).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("not reachable"),
    });
  });

  it("rejects a cancelled write before sending it, and a cancelled read as aborted", async () => {
    const { host, seen } = await studio({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.save(
        "acme",
        { name: "Acme", source: { kind: "scratch" }, spec: sampleSpec() },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    await expect(host.attach("acme", controller.signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(host.list(controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
  });

  it("reads another project's extraction by its key, and passes the service's refusal on", async () => {
    const { host, seen } = await studio({
      [`GET ${PROJECT}/extract/external/k%2F9`]: (_request, response) =>
        json(response, 200, {
          files: ["index.html"],
          colors: [],
          fonts: [],
          easings: [],
          durations: [],
          radii: [],
          fontSizes: [],
          shadows: [],
          declaredTokens: {},
        }),
    });
    expect((await host.externalProject("k/9", signal())).files).toEqual(["index.html"]);
    expect(seen.map((request) => request.path)).toEqual([`${PROJECT}/extract/external/k%2F9`]);
    await expect(host.externalProject("proj-9", signal())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
