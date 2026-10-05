import { describe, expect, it } from "vitest";
import { QA_SCOPE_REASONS, type QaPassState } from "@hyperframes/agent-protocol";
import { qaPass } from "../../agent/agentTestHarness";
import { isTranslationKey } from "../../i18n";
import { isPassRenderLinked, qaScopeLabel, qaScopeNoteText } from "./qaLabels";

describe("qa scope wording", () => {
  it("has Studio copy for every reason the runtime can give", () => {
    for (const code of QA_SCOPE_REASONS) {
      expect(isTranslationKey(`qa.scope.${code}`), code).toBe(true);
    }
  });

  it("fills the note's placeholders and labels only the reduced scopes", () => {
    expect(qaScopeNoteText({ code: "small_change", message: "x", params: { count: 3 } })).toBe(
      "3 clips were retimed since the last check, so the visual review was skipped.",
    );
    expect(qaScopeLabel(undefined)).toBeNull();
    expect(qaScopeLabel("full")).toBeNull();
    expect(qaScopeLabel("timeline")).toBe("chat.qa.scope.timeline");
    expect(qaScopeLabel("deterministic")).toBe("chat.qa.scope.deterministic");
  });
});

describe("isPassRenderLinked", () => {
  const first: QaPassState = qaPass({ pass: 1, renderPath: "renders/a.mp4" });
  const second: QaPassState = qaPass({ pass: 2, renderPath: "renders/b.mp4" });
  const unrendered: QaPassState = qaPass({ pass: 3, renderPath: null });

  it("follows the session's own record once it ended", () => {
    const kept = { ...first, renderKept: true };
    const removed = { ...second, renderKept: false };
    expect(isPassRenderLinked(kept, [kept, removed], false)).toBe(true);
    expect(isPassRenderLinked(removed, [kept, removed], false)).toBe(false);
  });

  it("links every render while the session runs", () => {
    expect(isPassRenderLinked(first, [first, second], true)).toBe(true);
    expect(isPassRenderLinked(second, [first, second], true)).toBe(true);
  });

  it("keeps only the last rendered pass for a session stored without the record", () => {
    const passes = [first, second, unrendered];
    expect(isPassRenderLinked(first, passes, false)).toBe(false);
    expect(isPassRenderLinked(second, passes, false)).toBe(true);
  });

  it("never links a pass that rendered nothing", () => {
    expect(isPassRenderLinked(unrendered, [first, unrendered], true)).toBe(false);
  });
});
