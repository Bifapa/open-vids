import { act } from "react";
import { AgentStoreProvider } from "../../agent/agentContext";
import {
  createAgentStore,
  type AgentState,
  type AgentStore,
  type AgentStoreDeps,
} from "../../agent/agentStore";
import {
  CATALOG,
  chatState,
  createFakeClient,
  createSourceLog,
  type FakeClient,
  type FakeClientData,
  type SourceLog,
} from "../../agent/agentTestHarness";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { AgentChatBody } from "./AgentChatPanel";

export interface Mounted {
  host: HTMLElement;
  store: AgentStore;
  client: FakeClient;
  sources: SourceLog;
}

/** The chat panel body on a real store with a fake client, pre-seeded with `state`. */
export function mountChat(
  state: Partial<AgentState>,
  data: FakeClientData = {},
  deps: Pick<AgentStoreDeps, "projectHasMedia"> = {},
): Mounted {
  const client = createFakeClient({ chat: chatState(), ...data });
  const sources = createSourceLog();
  const store = createAgentStore({ client, openEventSource: sources.open, ...deps });
  store.setState({ availability: "ready", models: CATALOG, ...state });
  const host = mountHost(
    <AgentStoreProvider store={store}>
      <AgentChatBody />
    </AgentStoreProvider>,
  );
  return { host, store, client, sources };
}

export function unmountChat(mounted?: Mounted) {
  mounted?.store.getState().dispose();
  cleanupMounted();
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Sets a React-controlled field's value the way typing would. */
export async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function pressKey(element: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export const byLabel = <T extends Element>(host: ParentNode, label: string) =>
  host.querySelector<T>(`[aria-label="${label}"]`);

export function buttonWithText(host: ParentNode, text: string): HTMLButtonElement | null {
  const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.trim().startsWith(text),
  );
  return match ?? null;
}
