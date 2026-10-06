// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { takeOpenvidsDesignParam } from "./designParam";

function visit(search: string, hash = "#project/demo") {
  window.history.replaceState(null, "", `/${search}${hash}`);
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("takeOpenvidsDesignParam", () => {
  it("reads the one-shot create request once and strips it, keeping the rest of the address", () => {
    visit("?openvidsHome=http%3A%2F%2F127.0.0.1%3A1&openvidsDesign=create");
    expect(takeOpenvidsDesignParam()).toEqual({ source: "scratch" });
    expect(window.location.search).toBe("?openvidsHome=http%3A%2F%2F127.0.0.1%3A1");
    expect(window.location.hash).toBe("#project/demo");
    // A reload (or a second read) finds nothing left to do.
    expect(takeOpenvidsDesignParam()).toBeNull();
  });

  it("preselects the source the Projects page asked for, and strips both parameters", () => {
    visit("?openvidsDesign=create&openvidsDesignSource=website");
    expect(takeOpenvidsDesignParam()).toEqual({ source: "website" });
    expect(window.location.search).toBe("");
  });

  it("falls back to a brief for a source it does not offer, and asks for nothing without 'create'", () => {
    visit("?openvidsDesign=create&openvidsDesignSource=external_project");
    expect(takeOpenvidsDesignParam()).toEqual({ source: "scratch" });

    visit("?openvidsDesign=other&openvidsDesignSource=video");
    expect(takeOpenvidsDesignParam()).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("leaves an address without the parameters alone", () => {
    visit("?openvidsFrame=custom");
    expect(takeOpenvidsDesignParam()).toBeNull();
    expect(window.location.search).toBe("?openvidsFrame=custom");
  });
});
