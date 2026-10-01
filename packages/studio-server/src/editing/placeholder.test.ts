// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isUntouchedTemplatePlaceholder } from "./placeholder.js";
import { parseComposition, serializeModel, toSnapshot } from "./timeline.js";

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../cli/src/templates/blank/index.html", import.meta.url)),
  "utf-8",
);

/** The template's only clip, after `change` was applied to its element (and the file re-serialized, as Studio does). */
function templateClip(change: (element: Element) => void = () => undefined) {
  const model = parseComposition(TEMPLATE, "index.html");
  const clip = model?.clips[0];
  if (!model || !clip) throw new Error("the template has a clip");
  change(clip.element);
  const html = serializeModel(model);
  const reparsed = parseComposition(html, "index.html");
  const element = reparsed?.clips[0];
  if (!reparsed || !element) throw new Error("the changed template has a clip");
  return { html, model: reparsed, element: element.element };
}

describe("template placeholder", () => {
  it("is what the blank template ships: its title clip is an untouched placeholder", () => {
    const { html, model, element } = templateClip();
    expect(model.clips).toHaveLength(1);
    expect(isUntouchedTemplatePlaceholder(element)).toBe(true);
    expect(toSnapshot(model, "index.html", html, () => undefined).clips[0]?.placeholder).toBe(true);
  });

  it("survives Studio's id stamping and a patched composition length", () => {
    const { model, element } = templateClip((clip) => {
      clip.setAttribute("data-hf-id", "hf-x1");
      clip.parentElement?.setAttribute("data-duration", "15");
    });
    expect(model.duration).toBe(15);
    expect(isUntouchedTemplatePlaceholder(element)).toBe(true);
  });

  it.each<[string, (element: Element) => void]>([
    ["typed text", (element) => void (element.textContent = "My talk")],
    ["a retimed clip", (element) => element.setAttribute("data-duration", "7")],
    ["a moved clip", (element) => element.setAttribute("data-start", "2")],
    ["another track", (element) => element.setAttribute("data-track-index", "3")],
    ["a restyled clip", (element) => element.setAttribute("style", "color: red")],
    ["a lock", (element) => element.setAttribute("data-timeline-locked", "")],
    ["a project without the marker", (element) => element.removeAttribute("data-ov-placeholder")],
    ["another marker value", (element) => element.setAttribute("data-ov-placeholder", "other")],
    ["a nested element", (element) => void (element.innerHTML = "<span>Title</span>")],
  ])("is not a removable placeholder after %s", (_name, change) => {
    const { html, model, element } = templateClip(change);
    expect(isUntouchedTemplatePlaceholder(element)).toBe(false);
    expect(
      toSnapshot(model, "index.html", html, () => undefined).clips[0]?.placeholder,
    ).toBeUndefined();
  });
});
