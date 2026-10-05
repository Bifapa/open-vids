// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustedSource } from "@hyperframes/agent-protocol";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { settle } from "../story/storyTestHarness";
import { AssetSearchPolicyView } from "./AssetSearchPolicyView";
import { createResearchClient } from "./researchClient";
import { ResearchProvider } from "./researchContext";
import {
  HttpReply,
  policyFixture,
  researchFetch,
  trustedSource,
  type RecordedRequest,
} from "./researchTestHarness";
import { createSourcesStore } from "./sourcesStore";

let host: HTMLElement;
let requests: RecordedRequest[];

/** The policy view over fake routes; `wrap` can hold a request back (the key on its way). */
async function mount(
  routes: Record<string, (body: unknown) => unknown>,
  wrap: (fetchImpl: typeof fetch) => typeof fetch = (fetchImpl) => fetchImpl,
) {
  const fake = researchFetch(routes);
  requests = fake.requests;
  const client = createResearchClient(wrap(fake.fetch));
  await act(async () => {
    host = mountHost(
      <ResearchProvider store={createSourcesStore(client)} client={client}>
        <AssetSearchPolicyView />
      </ResearchProvider>,
    );
    await settle();
  });
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim().startsWith(label) ||
      candidate.getAttribute("aria-label") === label,
  ) ?? null;

async function click(element: Element | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

async function type(element: HTMLInputElement | null, text: string) {
  if (!element) throw new Error("no field");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const KEY_URL = "/api/research/sources/pexels/api-key";
const pexels = (configured: boolean, overrides: Partial<TrustedSource> = {}) =>
  trustedSource({
    id: "pexels",
    name: "Pexels",
    connector: "pexels",
    domains: ["pexels.com"],
    kinds: ["picture", "video"],
    description: "Free stock photos and videos.",
    licenseNote: "Pexels License.",
    homepage: "https://www.pexels.com",
    apiKey: { signupUrl: "https://www.pexels.com/api/new/", configured },
    ...overrides,
  });
const withPexels = (source: TrustedSource) => policyFixture({ sources: [trustedSource(), source] });

const row = () => host.querySelector('[data-source-id="pexels"]');
const control = () => host.querySelector('[data-api-key="pexels"]');
const field = () => control()?.querySelector<HTMLInputElement>("input") ?? null;
const alerts = () => [...host.querySelectorAll('[role="alert"]')];

async function submitKey() {
  await act(async () => {
    control()
      ?.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
}

afterEach(() => cleanupMounted());

describe("API keys of built-in Asset Search sources", () => {
  it("shows no key controls on a source that needs no key", async () => {
    await mount({ "GET /api/research/policy": () => policyFixture() });

    expect(host.querySelector('[data-source-id="wikimedia-commons"]')).not.toBeNull();
    expect(host.querySelector("[data-api-key]")).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).not.toContain("Needs key");
    expect(host.textContent).not.toContain("API keys are stored");
  });

  it("marks an enabled source without a key as not searched, with a link to get one", async () => {
    await mount({
      "GET /api/research/policy": () => withPexels(pexels(false)),
      "PATCH /api/research/sources/pexels": () => withPexels(pexels(false, { enabled: false })),
    });

    expect(row()?.textContent).toContain("Needs key");
    expect(control()?.textContent).toContain(
      "Needs your own free API key. Not searched until you add one.",
    );
    const link = control()?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.pexels.com/api/new/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toContain("Get a key");
    expect(field()?.type).toBe("password");
    expect(field()?.getAttribute("autocomplete")).toBe("off");
    expect(field()?.getAttribute("spellcheck")).toBe("false");
    expect(host.textContent).toContain("API keys are stored in a private file");

    // The switch keeps working; a source that is off does not claim to be waiting for a key.
    await click(host.querySelector('[role="switch"][aria-label="Use Pexels"]'));
    expect(requests).toContainEqual({
      method: "PATCH",
      url: "/api/research/sources/pexels",
      body: { enabled: false },
    });
    expect(row()?.textContent).not.toContain("Needs key");
    expect(control()?.textContent).toContain("Needs your own free API key");
  });

  it("saves a pasted key with a PUT, then says Key saved and never shows the key", async () => {
    let policy = withPexels(pexels(false));
    await mount({
      "GET /api/research/policy": () => policy,
      "PUT /api/research/sources/pexels/api-key": () => {
        policy = withPexels(pexels(true));
        return policy;
      },
    });

    await type(field(), "  secret-key-123  ");
    await submitKey();

    expect(requests).toContainEqual({
      method: "PUT",
      url: KEY_URL,
      body: { key: "secret-key-123" },
    });
    expect(control()?.textContent).toContain("Key saved");
    expect(field()).toBeNull();
    expect(row()?.textContent).not.toContain("Needs key");
    expect(host.innerHTML).not.toContain("secret-key-123");
    expect(document.activeElement).toBe(button("Replace the Pexels API key"));
  });

  it("keeps the Save button busy while the key is on its way, and sends it once", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount(
      {
        "GET /api/research/policy": () => withPexels(pexels(false)),
        "PUT /api/research/sources/pexels/api-key": () => withPexels(pexels(true)),
      },
      (fetchImpl) => async (input, init) => {
        if (init?.method === "PUT") await held;
        return fetchImpl(input, init);
      },
    );

    await type(field(), "secret-key-123");
    await submitKey();
    expect(control()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(field()?.readOnly).toBe(true);
    await submitKey();

    await act(async () => {
      release();
      await settle();
    });
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(control()?.textContent).toContain("Key saved");
  });

  it("asks for a key before sending anything", async () => {
    await mount({ "GET /api/research/policy": () => withPexels(pexels(false)) });

    await type(field(), "   ");
    await submitKey();

    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    expect(control()?.querySelector('[role="alert"]')?.textContent).toBe("Paste an API key first.");
  });

  it("shows the server's refusal at the field and keeps what was typed", async () => {
    await mount({
      "GET /api/research/policy": () => withPexels(pexels(false)),
      "PUT /api/research/sources/pexels/api-key": () =>
        new HttpReply(400, {
          error: { code: "invalid_request", message: "Pexels needs a shorter key" },
        }),
    });

    await type(field(), "bad-key");
    await submitKey();

    expect(control()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Pexels needs a shorter key",
    );
    expect(alerts()).toHaveLength(1);
    expect(field()?.value).toBe("bad-key");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(row()?.textContent).toContain("Needs key");

    await type(field(), "other-key");
    expect(alerts()).toHaveLength(0);
  });

  it("offers Replace and Remove once a key is saved, and removes it with a DELETE", async () => {
    let policy = withPexels(pexels(true));
    await mount({
      "GET /api/research/policy": () => policy,
      "DELETE /api/research/sources/pexels/api-key": () => {
        policy = withPexels(pexels(false));
        return policy;
      },
    });

    expect(control()?.textContent).toContain("Key saved");
    expect(row()?.textContent).not.toContain("Needs key");
    expect(field()).toBeNull();

    await click(button("Replace the Pexels API key"));
    expect(field()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    await click(button("Cancel"));
    expect(field()).toBeNull();
    expect(requests.some((request) => request.method !== "GET")).toBe(false);

    await click(button("Remove the Pexels API key"));
    expect(requests).toContainEqual({ method: "DELETE", url: KEY_URL, body: undefined });
    expect(control()?.textContent).not.toContain("Key saved");
    expect(control()?.textContent).toContain("Needs your own free API key");
    expect(row()?.textContent).toContain("Needs key");
    expect(document.activeElement).toBe(field());
  });

  it("replaces a saved key with the one pasted into the reopened field", async () => {
    await mount({
      "GET /api/research/policy": () => withPexels(pexels(true)),
      "PUT /api/research/sources/pexels/api-key": () => withPexels(pexels(true)),
    });

    await click(button("Replace the Pexels API key"));
    await type(field(), "new-key-456");
    await submitKey();

    expect(requests).toContainEqual({
      method: "PUT",
      url: KEY_URL,
      body: { key: "new-key-456" },
    });
    expect(field()).toBeNull();
    expect(control()?.textContent).toContain("Key saved");
  });

  it("shows a refused removal at the key, not at the top of the list", async () => {
    await mount({
      "GET /api/research/policy": () => withPexels(pexels(true)),
      "DELETE /api/research/sources/pexels/api-key": () =>
        new HttpReply(500, { error: { code: "internal", message: "Could not forget the key" } }),
    });

    await click(button("Remove the Pexels API key"));

    expect(control()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not forget the key",
    );
    expect(alerts()).toHaveLength(1);
    expect(control()?.textContent).toContain("Key saved");
  });
});
