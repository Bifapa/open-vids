import { describe, expect, it, vi } from "vitest";
import { createRequestPolicy } from "./requestPolicy.js";

const PUBLIC = "93.184.216.34";

describe("the request policy", () => {
  it("lets public http(s) hosts through and network-free schemes", async () => {
    const resolve = vi.fn(async () => [PUBLIC]);
    const policy = createRequestPolicy(resolve);
    for (const url of [
      "https://example.com/a.css",
      "http://cdn.example.com:8080/x",
      "data:image/png;base64,AAAA",
      "blob:https://example.com/1234",
      "about:blank",
      "https://93.184.216.34/",
    ]) {
      expect(await policy.check(url)).toBeNull();
    }
  });

  it.each([
    ["http://127.0.0.1:5480/", "local or private"],
    ["http://169.254.169.254/latest/meta-data/", "local or private"],
    ["http://10.1.2.3/", "local or private"],
    ["http://[::1]/", "local or private"],
    ["http://[::ffff:127.0.0.1]/", "local or private"],
    ["http://0.0.0.0/", "local or private"],
    ["http://localhost/", "local network name"],
    ["http://printer.local/", "local network name"],
    ["http://intranet/", "local network name"],
    ["file:///etc/passwd", "Only http and https"],
    ["ftp://example.com/", "Only http and https"],
    ["ws://example.com/", "Only http and https"],
    ["https://user:pw@example.com/", "user name or password"],
  ])("refuses %s", async (url, reason) => {
    const policy = createRequestPolicy(async () => [PUBLIC]);
    const refusal = await policy.check(url);
    expect(refusal?.kind).toBe("blocked");
    expect(refusal?.reason).toContain(reason);
  });

  it("resolves a name and refuses it when any answer is private, asking DNS once per host", async () => {
    const resolve = vi.fn(async (host: string) =>
      host === "rebind.example.com" ? [PUBLIC, "192.168.1.5"] : [PUBLIC],
    );
    const policy = createRequestPolicy(resolve);
    expect((await policy.check("https://rebind.example.com/a"))?.reason).toContain("192.168.1.5");
    expect(await policy.check("https://rebind.example.com/b")).not.toBeNull();
    expect(await policy.check("https://ok.example.com/a")).toBeNull();
    expect(await policy.check("https://ok.example.com/b")).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("refuses a host that cannot be looked up, as a lookup failure", async () => {
    const policy = createRequestPolicy(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await policy.check("https://nope.example.com/")).toEqual({
      kind: "lookup",
      reason: "Could not look up nope.example.com",
    });
  });

  it("flags a connection that really went to a private address (a name that rebound after the check)", () => {
    const policy = createRequestPolicy(async () => [PUBLIC]);
    expect(policy.remoteAddressProblem("127.0.0.1")).toContain("127.0.0.1");
    expect(policy.remoteAddressProblem("[::1]")).toContain("::1");
    expect(policy.remoteAddressProblem(PUBLIC)).toBeNull();
    expect(policy.remoteAddressProblem(undefined)).toBeNull();
    expect(policy.remoteAddressProblem("")).toBeNull();
  });
});
