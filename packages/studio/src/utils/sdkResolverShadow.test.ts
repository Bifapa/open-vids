// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sdkResolverShadowCheck, type SdkResolverMismatch } from "./sdkResolverShadow";
import type { PatchOperation } from "./sourcePatcher";
import { openComposition } from "@hyperframes/sdk";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <div data-hf-id="hf-box" style="color: red; width: 100px;" data-name="box">Hello</div>
</body></html>`;

// Prevents setStyle from applying so the read-back value differs from expected.
// Used to simulate a silent SDK value-dispatch bug.
async function makePoisonedStyleSession() {
  const session = await openComposition(BASE_HTML);
  const origDispatch = session.dispatch.bind(session);
  session.dispatch = (op) => {
    if (typeof op === "object" && "type" in op && op.type === "setStyle") return;
    origDispatch(op);
  };
  return session;
}

// ─── Session-restore (shared session with the cutover path) ───────────────────

describe("resolver shadow leaves the shared session untouched", () => {
  it("the live session is restored after the check", async () => {
    // The session is shared with the cutover path. The shadow dispatches into it
    // to read values back, then MUST undo those mutations — otherwise the edit is
    // pre-applied and the following sdkCutoverPersist sees before === after and
    // silently falls back to the server path.
    const session = await openComposition(BASE_HTML);
    expect(session.getElement("hf-box")?.inlineStyles.color).toBe("red");

    const mismatches = sdkResolverShadowCheck(session, "hf-box", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    expect(mismatches).toHaveLength(0); // SDK applied blue == expected → parity

    // …but the session is back to its pre-check state, NOT left on "blue".
    expect(session.getElement("hf-box")?.inlineStyles.color).toBe("red");
  });

  it("a cutover-style serialize diff survives a preceding shadow run", async () => {
    const session = await openComposition(BASE_HTML);
    sdkResolverShadowCheck(session, "hf-box", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    const before = session.serialize();
    session.dispatch({ type: "setStyle", target: "hf-box", styles: { color: "blue" } });
    const after = session.serialize();
    expect(after).not.toBe(before); // cutover would write, not fall back
  });
});

// ─── Resolver-parity detection ────────────────────────────────────────────────

describe("resolver-parity detection", () => {
  it("match → no mismatches", async () => {
    const session = await openComposition(BASE_HTML);
    const mismatches = sdkResolverShadowCheck(session, "hf-box", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    expect(mismatches).toHaveLength(0);
  });

  it("element_not_found when the SDK resolver returns null", () => {
    const session = { getElement: () => null, getElements: () => [] } as unknown as Parameters<
      typeof sdkResolverShadowCheck
    >[0];
    const mismatches = sdkResolverShadowCheck(
      session as unknown as Parameters<typeof sdkResolverShadowCheck>[0],
      "hf-box",
      [{ type: "inline-style", property: "color", value: "red" }],
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject<SdkResolverMismatch>({
      kind: "element_not_found",
      hfId: "hf-box",
    });
  });

  it("no element_not_found when the SDK resolves", async () => {
    const session = await openComposition(BASE_HTML);
    const mismatches = sdkResolverShadowCheck(session, "hf-box", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    expect(mismatches.some((m) => m.kind === "element_not_found")).toBe(false);
  });

  it("value_mismatch when dispatch yields a different value than expected", async () => {
    const session = await makePoisonedStyleSession();
    const mismatches = sdkResolverShadowCheck(session, "hf-box", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject<SdkResolverMismatch>({
      kind: "value_mismatch",
      hfId: "hf-box",
      property: "color",
      expected: "blue",
    });
  });

  it("runtime-node filter: hfId absent from source → suppressed (not a resolver bug)", () => {
    const session = { getElement: () => null, getElements: () => [] } as unknown as Parameters<
      typeof sdkResolverShadowCheck
    >[0];
    const source = `<div data-hf-id="hf-static">no runtime id here</div>`;
    const mismatches = sdkResolverShadowCheck(
      session,
      "hf-runtimeonly",
      [{ type: "inline-style", property: "color", value: "red" }],
      source,
    );
    expect(mismatches).toHaveLength(0);
  });

  it("runtime-node filter: hfId present in source but missing from session → still flagged", () => {
    const session = { getElement: () => null, getElements: () => [] } as unknown as Parameters<
      typeof sdkResolverShadowCheck
    >[0];
    const source = `<div data-hf-id="hf-realbug">in source, not in SDK session</div>`;
    const mismatches = sdkResolverShadowCheck(
      session,
      "hf-realbug",
      [{ type: "inline-style", property: "color", value: "red" }],
      source,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.kind).toBe("element_not_found");
  });

  it("unmappable op type produces no mismatch (excluded, not flagged)", async () => {
    const session = await openComposition(BASE_HTML);
    const ops = [{ type: "unknown-op", property: "x", value: "y" }] as unknown as PatchOperation[];
    const mismatches = sdkResolverShadowCheck(session, "hf-box", ops);
    expect(mismatches).toHaveLength(0);
  });
});

// ─── Inlined sub-composition: bare leaf id resolves (regression) ──────────────

describe("inlined sub-composition leaf", () => {
  const INLINED_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <div data-hf-id="hf-root" data-hf-root>
    <div data-hf-id="hf-host" data-composition-file="sub.html">
      <div data-hf-id="hf-leaf" style="color: red">Subscribe</div>
    </div>
  </div>
</body></html>`;

  it("getElement(bareLeaf) is null (canonical-only) — the trap the check used to hit", async () => {
    const session = await openComposition(INLINED_HTML);
    expect(session.getElement("hf-leaf")).toBeNull();
    expect(session.getElement("hf-host/hf-leaf")).not.toBeNull();
  });

  it("sdkResolverShadowCheck does not flag element_not_found for a bare leaf in a sub-comp", async () => {
    const session = await openComposition(INLINED_HTML);
    const mismatches = sdkResolverShadowCheck(session, "hf-leaf", [
      { type: "inline-style", property: "color", value: "blue" },
    ]);
    expect(mismatches.some((m) => m.kind === "element_not_found")).toBe(false);
  });
});
