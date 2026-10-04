import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENVIDS_HOME_PARAM,
  isHomeAboutInfo,
  isValidOpenvidsHomeOrigin,
  readHomeAbout,
  readOpenvidsFrame,
  readOpenvidsHomeOrigin,
} from "./openvidsHost";

describe("isValidOpenvidsHomeOrigin", () => {
  it("accepts http loopback origins with a port", () => {
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:57035")).toBe(true);
    expect(isValidOpenvidsHomeOrigin("http://localhost:5190")).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isValidOpenvidsHomeOrigin("http://192.168.1.5:57035")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://example.com:57035")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1.evil.com:57035")).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(isValidOpenvidsHomeOrigin("https://127.0.0.1:57035")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("file:///etc/passwd")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("javascript:alert(1)")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("tauri://localhost")).toBe(false);
  });

  it("rejects origins that smuggle path, query, fragment or credentials", () => {
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:57035/evil")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:57035?x=1")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:57035#frag")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://user:pass@127.0.0.1:57035")).toBe(false);
  });

  it("rejects missing ports and garbage", () => {
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://localhost")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("not a url")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:abc")).toBe(false);
  });

  it("rejects origins that only normalize to loopback", () => {
    expect(isValidOpenvidsHomeOrigin("http://127.0.0.1:57035/")).toBe(false);
    expect(isValidOpenvidsHomeOrigin("HTTP://127.0.0.1:57035")).toBe(false);
  });
});

describe("readOpenvidsHomeOrigin", () => {
  it("returns null when the param is absent", () => {
    expect(readOpenvidsHomeOrigin("")).toBeNull();
    expect(readOpenvidsHomeOrigin("?tab=design")).toBeNull();
  });

  it("returns the origin for a valid param", () => {
    expect(
      readOpenvidsHomeOrigin(
        `?${OPENVIDS_HOME_PARAM}=${encodeURIComponent("http://127.0.0.1:57035")}`,
      ),
    ).toBe("http://127.0.0.1:57035");
  });

  it("returns null for an invalid param instead of navigating anywhere", () => {
    expect(
      readOpenvidsHomeOrigin(
        `?${OPENVIDS_HOME_PARAM}=${encodeURIComponent("http://example.com:57035")}`,
      ),
    ).toBeNull();
    expect(
      readOpenvidsHomeOrigin(
        `?${OPENVIDS_HOME_PARAM}=${encodeURIComponent("javascript:alert(1)")}`,
      ),
    ).toBeNull();
  });
});

describe("readOpenvidsFrame", () => {
  it("defaults to overlay without the param", () => {
    expect(readOpenvidsFrame("")).toBe("overlay");
    expect(readOpenvidsFrame("?tab=design")).toBe("overlay");
  });

  it("reads the Windows frames", () => {
    expect(readOpenvidsFrame("?openvidsFrame=custom")).toBe("custom");
    expect(readOpenvidsFrame("?openvidsFrame=system")).toBe("system");
  });

  it("falls back to overlay for unknown values, never to buttons", () => {
    expect(readOpenvidsFrame("?openvidsFrame=overlay")).toBe("overlay");
    expect(readOpenvidsFrame("?openvidsFrame=frameless")).toBe("overlay");
    expect(readOpenvidsFrame("?openvidsFrame=")).toBe("overlay");
  });
});

describe("isHomeAboutInfo", () => {
  it("accepts an object whose present fields are strings, absent ones included", () => {
    expect(isHomeAboutInfo({})).toBe(true);
    expect(isHomeAboutInfo({ name: "OpenVids", version: "0.2.0" })).toBe(true);
    expect(isHomeAboutInfo({ extra: 1, website: "https://openvids.ai", credits: "x" })).toBe(true);
  });

  it.each([
    null,
    undefined,
    "OpenVids",
    7,
    [],
    [{ name: "OpenVids" }],
    { name: 1 },
    { version: null },
    { website: ["https://openvids.ai"] },
    { comment: {} },
  ])("rejects %j", (value) => {
    expect(isHomeAboutInfo(value)).toBe(false);
  });
});

describe("readHomeAbout", () => {
  const HOME = "http://127.0.0.1:57035";
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const answer = (body: unknown, ok = true) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, json: async () => body })),
    );

  it("returns the strings the home server sent", async () => {
    answer({ name: "OpenVids", version: "0.2.0" });
    await expect(readHomeAbout(HOME)).resolves.toEqual({ name: "OpenVids", version: "0.2.0" });
  });

  it("returns null for a body of the wrong shape, a failed status or a bad origin", async () => {
    answer([{ name: "OpenVids" }]);
    await expect(readHomeAbout(HOME)).resolves.toBeNull();
    answer({ name: 42 });
    await expect(readHomeAbout(HOME)).resolves.toBeNull();
    answer({ name: "OpenVids" }, false);
    await expect(readHomeAbout(HOME)).resolves.toBeNull();
    answer({ name: "OpenVids" });
    await expect(readHomeAbout("http://example.com:57035")).resolves.toBeNull();
  });
});
