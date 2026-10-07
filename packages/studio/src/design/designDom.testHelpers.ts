import { act } from "react";
import { isRecord } from "@hyperframes/agent-protocol";

/** happy-dom would fetch an iframe's `src` for real; a test that only inspects the frame's attributes turns that off. */
export function disableIframeLoading(): void {
  const happyDom: unknown = Reflect.get(window, "happyDOM");
  const settings = isRecord(happyDom) ? happyDom.settings : undefined;
  if (isRecord(settings)) settings.disableIframePageLoading = true;
}

/** Lets effects, resolved fetches and Base UI's transitions run. */
export async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

/** A full mouse press, the way a browser delivers it (Base UI listens to pointer events). */
export function press(target: Element): void {
  const init = { bubbles: true, cancelable: true, composed: true, detail: 1 };
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  });
}

export async function pressAndSettle(target: Element | null): Promise<void> {
  if (!target) throw new Error("nothing to press");
  press(target);
  await settle();
}

export function pressEscape(): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

/** Sets a React-controlled field's value the way typing would. */
export async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The text field a visible `<label>` names (the way a user finds it). */
export function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
  const named = byText<HTMLLabelElement>(document, "label", label);
  const control = named ? document.getElementById(named.htmlFor) : null;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) return control;
  throw new Error(`no field labelled "${label}"`);
}

export function byText<T extends Element>(
  root: ParentNode,
  selector: string,
  text: string | RegExp,
): T | null {
  const matches = (content: string) =>
    typeof text === "string" ? content.trim() === text : text.test(content);
  return (
    [...root.querySelectorAll<T>(selector)].find((element) => matches(element.textContent ?? "")) ??
    null
  );
}
