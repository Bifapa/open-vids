import { act, type ReactElement } from "react";
import { VoiceProvider } from "./voiceContext";
import { createFakeVoice, type FakeVoice, type FakeVoiceData } from "./voiceTestHarness";
import { mountHost } from "../components/ui/mountHost.testHelpers";

/** Lets effects, resolved fetches and Base UI's transitions run. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

export async function pressAndSettle(target: Element | null | undefined): Promise<void> {
  if (!target) throw new Error("nothing to press");
  press(target);
  await settle();
}

/** Sets a React-controlled field's value the way typing would. */
export async function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Commits an `Input` the way a user does: type, then Enter. */
export async function typeAndEnter(field: HTMLInputElement, value: string): Promise<void> {
  await typeInto(field, value);
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

export async function blur(field: Element): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    if (field instanceof HTMLElement) field.blur();
  });
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

export const button = (root: ParentNode, text: string | RegExp) =>
  byText<HTMLButtonElement>(root, "button", text);

export const byLabel = <T extends Element>(root: ParentNode, label: string) =>
  root.querySelector<T>(`[aria-label="${label}"]`);

export const byTestId = <T extends Element>(root: ParentNode, id: string) =>
  root.querySelector<T>(`[data-testid="${id}"]`);

/** Mounts `element` on a fake voice service; returns the host, the fake and its store. */
export function mountVoice(
  element: ReactElement,
  data: FakeVoiceData = {},
): { host: HTMLElement } & FakeVoice {
  const fake = createFakeVoice(data);
  const host = mountHost(
    <VoiceProvider client={fake.client} store={fake.store}>
      {element}
    </VoiceProvider>,
  );
  return { host, ...fake };
}
