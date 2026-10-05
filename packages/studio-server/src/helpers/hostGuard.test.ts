import { afterEach, describe, expect, it } from "vitest";
import { checkStudioRequest, isOwnStudioOrigin } from "./hostGuard.js";

const BIND_ENV = "HYPERFRAMES_PREVIEW_HOST";
const originalBind = process.env[BIND_ENV];

afterEach(() => {
  if (originalBind === undefined) delete process.env[BIND_ENV];
  else process.env[BIND_ENV] = originalBind;
});

function check(
  method: string,
  headers: { host?: string; origin?: string; secFetchSite?: string },
  url = "http://127.0.0.1:5401/api/x",
) {
  return checkStudioRequest({
    method,
    url,
    host: headers.host,
    origin: headers.origin,
    secFetchSite: headers.secFetchSite,
  });
}

describe("checkStudioRequest host", () => {
  it.each(["127.0.0.1:5401", "localhost:5401", "[::1]:5401", "127.0.0.1"])(
    "accepts loopback Host %s",
    (host) => {
      expect(check("GET", { host })).toBe("ok");
    },
  );

  it.each(["evil.example", "evil.example:5401", "127.0.0.1.evil.example:5401", "10.0.0.5:5401"])(
    "refuses Host %s on every method",
    (host) => {
      delete process.env[BIND_ENV];
      expect(check("GET", { host })).toBe("untrusted_host");
      expect(check("POST", { host })).toBe("untrusted_host");
    },
  );

  it("falls back to the request URL host when no Host header exists (in-process calls)", () => {
    expect(check("GET", {}, "http://localhost/api/x")).toBe("ok");
    delete process.env[BIND_ENV];
    expect(check("GET", {}, "http://evil.example/api/x")).toBe("untrusted_host");
  });
});

describe("checkStudioRequest cross-origin", () => {
  const host = "127.0.0.1:5401";

  it("refuses a state-changing request from a foreign origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(check(method, { host, origin: "https://evil.example" })).toBe("cross_origin");
    }
  });

  it("refuses a sibling loopback port (the desktop home server) and a null origin", () => {
    expect(check("POST", { host, origin: "http://127.0.0.1:5402" })).toBe("cross_origin");
    expect(check("POST", { host, origin: "null" })).toBe("cross_origin");
  });

  it("refuses Sec-Fetch-Site: cross-site even without an Origin", () => {
    expect(check("POST", { host, secFetchSite: "cross-site" })).toBe("cross_origin");
  });

  it("accepts the server's own origin, under either loopback spelling", () => {
    expect(
      check("POST", { host, origin: "http://127.0.0.1:5401", secFetchSite: "same-origin" }),
    ).toBe("ok");
    expect(check("POST", { host: "localhost:5401", origin: "http://localhost:5401" })).toBe("ok");
  });

  it("accepts a request without Origin (CLI, the agent runtime's HTTP hosts)", () => {
    expect(check("POST", { host })).toBe("ok");
    expect(check("DELETE", { host })).toBe("ok");
  });

  it("does not police safe methods", () => {
    expect(check("GET", { host, origin: "https://evil.example", secFetchSite: "cross-site" })).toBe(
      "ok",
    );
    expect(check("OPTIONS", { host, origin: "https://evil.example" })).toBe("ok");
  });
});

describe("isOwnStudioOrigin", () => {
  it("requires the origin host to equal the Host and to be trusted", () => {
    delete process.env[BIND_ENV];
    expect(isOwnStudioOrigin("http://evil.example:5401", "evil.example:5401")).toBe(false);
    expect(isOwnStudioOrigin("http://127.0.0.1:5401", "localhost:5401")).toBe(false);
    expect(isOwnStudioOrigin("http://127.0.0.1:5401", "127.0.0.1:5401")).toBe(true);
    expect(isOwnStudioOrigin("file:///x", "127.0.0.1:5401")).toBe(false);
  });
});
