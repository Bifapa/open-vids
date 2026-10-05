// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { SourceEditor } from "./SourceEditor";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

function mountEditor(readOnly: boolean, content = "<p>hello</p>") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const render = (next: { readOnly: boolean; content?: string }) =>
    act(() =>
      root.render(
        <SourceEditor
          content={next.content ?? content}
          filePath="index.html"
          readOnly={next.readOnly}
        />,
      ),
    );
  render({ readOnly });
  const view = () => {
    const dom = host.querySelector<HTMLElement>(".cm-editor");
    return dom ? EditorView.findFromDOM(dom) : null;
  };
  return { render, view };
}

describe("source editor read-only mode", () => {
  it("flips without rebuilding the view, so the undo history and cursor survive a turn", () => {
    const { render, view } = mountEditor(false);
    const editor = view();
    expect(editor?.state.readOnly).toBe(false);

    render({ readOnly: true });
    expect(view()).toBe(editor);
    expect(view()?.state.readOnly).toBe(true);

    render({ readOnly: false });
    expect(view()).toBe(editor);
    expect(view()?.state.readOnly).toBe(false);
  });

  it("follows what the agent writes even while the locked editor has focus", () => {
    const { render, view } = mountEditor(false);
    view()?.focus();
    expect(view()?.hasFocus).toBe(true);

    // Unlocked and focused, a push would clobber the user's keystrokes, so it waits for blur.
    render({ readOnly: false, content: "<p>pushed while typing</p>" });
    expect(view()?.state.doc.toString()).toBe("<p>hello</p>");

    // Locked, there are no keystrokes to protect: the agent's rewrite shows at once.
    render({ readOnly: true, content: "<p>rewritten by the agent</p>" });
    expect(view()?.state.doc.toString()).toBe("<p>rewritten by the agent</p>");
  });
});
