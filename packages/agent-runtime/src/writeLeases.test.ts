import { describe, expect, it } from "vitest";
import { WriteLeases, leaseKey } from "./writeLeases.js";

describe("WriteLeases", () => {
  it("lets a run write a file again and refuses another run with the holder's name", () => {
    const leases = new WriteLeases();
    expect(leases.claim({ agent: "motion", runId: "run-motion" }, ["index.html"])).toBeNull();
    expect(leases.claim({ agent: "motion", runId: "run-motion" }, ["index.html"])).toBeNull();

    const refusal = leases.claim({ agent: "editor", runId: "run-editor" }, ["index.html"]);
    expect(refusal).toContain("Motion Designer");
    expect(refusal).toContain("run-motion");
    expect(leases.holderOf("index.html")).toEqual({ agent: "motion", runId: "run-motion" });
  });

  it("takes all of a run's files or none of them", () => {
    const leases = new WriteLeases();
    leases.claim({ agent: "editor", runId: "e" }, ["b.html"]);
    expect(leases.claim({ agent: "motion", runId: "m" }, ["a.html", "b.html"])).not.toBeNull();
    expect(leases.holderOf("a.html")).toBeNull();
  });

  it("never gives the Director a lease but holds it to the leases of others", () => {
    const leases = new WriteLeases();
    expect(leases.claim({ agent: "director", runId: null }, ["index.html"])).toBeNull();
    expect(leases.holderOf("index.html")).toBeNull();
    // The Director's own write does not block a run.
    expect(leases.claim({ agent: "editor", runId: "e" }, ["index.html"])).toBeNull();
    const refusal = leases.claim({ agent: "director", runId: null }, ["index.html"]);
    expect(refusal).toContain("Your write");
    expect(refusal).toContain("Editor");
  });

  it("frees a run's files when it ends, and check() takes nothing", () => {
    const leases = new WriteLeases();
    expect(leases.check({ agent: "editor", runId: "e" }, ["index.html"])).toBeNull();
    expect(leases.holderOf("index.html")).toBeNull();
    leases.claim({ agent: "editor", runId: "e" }, ["index.html", "compositions/x.html"]);
    expect(leases.check({ agent: "motion", runId: "m" }, ["compositions/x.html"])).not.toBeNull();
    leases.release("e");
    expect(leases.claim({ agent: "motion", runId: "m" }, ["index.html"])).toBeNull();
  });

  it("treats spellings of one path as one file", () => {
    expect(leaseKey("./Compositions\\Intro.HTML")).toBe("compositions/intro.html");
    const leases = new WriteLeases();
    leases.claim({ agent: "editor", runId: "e" }, ["Index.html"]);
    expect(leases.claim({ agent: "motion", runId: "m" }, ["./index.html"])).not.toBeNull();
  });

  it("resolves a path the way the editing service does, so no spelling gets around a lease", () => {
    expect(leaseKey("/index.html")).toBe("index.html");
    expect(leaseKey("compositions/../index.html")).toBe("index.html");
    expect(leaseKey("compositions//sub/./Intro.html")).toBe("compositions/sub/intro.html");
    // Nothing climbs out of the project root.
    expect(leaseKey("../index.html")).toBe("index.html");
    const leases = new WriteLeases();
    leases.claim({ agent: "editor", runId: "e" }, ["/index.html"]);
    expect(leases.claim({ agent: "motion", runId: "m" }, ["index.html"])).toContain("run e");
    expect(
      leases.claim({ agent: "motion", runId: "m" }, ["compositions/../Index.html"]),
    ).not.toBeNull();
    expect(leases.holderOf("./index.html")?.runId).toBe("e");
  });
});
