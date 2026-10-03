// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetSearchPolicy } from "@hyperframes/agent-protocol";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { settle } from "../story/storyTestHarness";
import { createResearchClient } from "./researchClient";
import { ResearchProvider } from "./researchContext";
import {
  HttpReply,
  policyFixture,
  researchFetch,
  sourceEntry,
  sourcesView,
  trustedSource,
  type RecordedRequest,
} from "./researchTestHarness";
import { createSourcesStore } from "./sourcesStore";
import { announceAssetSearchPolicyChanged } from "./policyChanges";
import { SourcesPanel } from "./SourcesPanel";

let host: HTMLElement;
let requests: RecordedRequest[];

const RECORDS = [
  sourceEntry(),
  sourceEntry({
    id: "prov-2",
    asset: "assets/research/city.jpg",
    mediaKind: "picture",
    title: "City at night",
    source: { id: "web", name: "example.org", trusted: false },
    license: "Unknown",
    licenseId: "unknown",
    licenseUrl: null,
    licenseConfidence: "none",
    licenseStatus: "unknown",
    licenseBasis: "",
    attribution: "“City at night”, license unknown, from example.org",
    issues: ["License unknown"],
    usedIn: [],
  }),
  sourceEntry({
    id: "prov-3",
    asset: "assets/research/drums.mp3",
    mediaKind: "audio",
    title: "Drums",
    license: "CC BY-NC 4.0",
    licenseStatus: "restricted",
    issues: ["Non-commercial license"],
    present: false,
  }),
  sourceEntry({
    id: "prov-4",
    asset: "assets/research/moon.jpg",
    mediaKind: "picture",
    title: "Moon",
    license: "Public domain (NASA)",
    licenseStatus: "clear",
  }),
];

async function mount(routes: Record<string, (body: unknown) => unknown>) {
  const fake = researchFetch(routes);
  requests = fake.requests;
  const client = createResearchClient(fake.fetch);
  const store = createSourcesStore(client);
  await act(async () => {
    host = mountHost(
      <ResearchProvider store={store} client={client}>
        <SourcesPanel />
      </ResearchProvider>,
    );
    await store.getState().open("p1");
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

async function type(element: HTMLInputElement | HTMLTextAreaElement | null, text: string) {
  if (!element) throw new Error("no field");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const record = (asset: string) => host.querySelector(`[data-source-record="${asset}"]`);

afterEach(() => cleanupMounted());

describe("Project sources", () => {
  it("shows each asset's license status, issues and missing file, with the credits", async () => {
    await mount({ "GET /api/projects/p1/research/sources": () => sourcesView(RECORDS) });

    const unknown = record("assets/research/city.jpg");
    expect(
      unknown?.querySelector("[data-license-status]")?.getAttribute("data-license-status"),
    ).toBe("unknown");
    expect(unknown?.textContent).toContain("License unknown");
    expect(unknown?.textContent).toContain("Web");
    expect(unknown?.textContent).toContain("Not on a timeline yet");

    const restricted = record("assets/research/drums.mp3");
    expect(restricted?.textContent).toContain("Non-commercial license");
    expect(restricted?.textContent).toContain("File missing from the project");

    const attribution = record("assets/research/ocean.mp4");
    expect(attribution?.textContent).toContain("Trusted");
    expect(attribution?.textContent).toContain("Research · claude-haiku · turn t1");
    const author = [...(attribution?.querySelectorAll("a") ?? [])].find(
      (link) => link.textContent === "Jane Doe",
    );
    expect(author?.getAttribute("href")).toBe("https://commons.wikimedia.org/wiki/User:Jane");
    expect(author?.getAttribute("target")).toBe("_blank");

    const summary = host.querySelector('[data-testid="sources-summary"]')?.textContent ?? "";
    expect(summary).toContain("4 assets");
    expect(summary).toContain("2 need a license check");
    expect(summary).toContain("1 missing file");
    const credits = host.querySelector('[aria-label="Credits"]')?.textContent ?? "";
    expect(credits).toContain("“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons");
    expect(credits).toContain("“City at night”, license unknown, from example.org");
  });

  it("filters the list by license status", async () => {
    await mount({ "GET /api/projects/p1/research/sources": () => sourcesView(RECORDS) });

    await click(button("Unknown"));

    const shown = [...host.querySelectorAll("[data-source-record]")].map((item) =>
      item.getAttribute("data-source-record"),
    );
    expect(shown).toEqual(["assets/research/city.jpg"]);
  });

  it("labels a saved website reference by its site, with its kind", async () => {
    await mount({
      "GET /api/projects/p1/research/sources": () =>
        sourcesView([
          sourceEntry({
            id: "prov-5",
            asset: "assets/web/linear.app/inter-600.woff2",
            mediaKind: "font",
            title: "Inter 600",
            source: { id: "website", name: "linear.app", trusted: false },
            originalUrl: "https://linear.app/fonts/inter-600.woff2",
            pageUrl: "https://linear.app/",
            license: "Unknown",
            licenseId: "unknown",
            licenseUrl: null,
            licenseConfidence: "none",
            licenseStatus: "unknown",
            licenseBasis: "",
            attribution: "From linear.app (website reference)",
            issues: ["License unknown"],
            usedIn: [],
          }),
        ]),
    });

    const font = record("assets/web/linear.app/inter-600.woff2");
    expect(font?.textContent).toContain("From linear.app");
    expect(font?.textContent).toContain("Fonts");
    expect(font?.textContent).not.toContain("Found on the open web");
    expect(font?.textContent).toContain("License unknown");
  });

  it("explains where researched assets come from when there are none", async () => {
    await mount({ "GET /api/projects/p1/research/sources": () => sourcesView([]) });

    expect(host.textContent).toContain("No researched assets yet");
    expect(host.textContent).toContain("Research agent imports");
  });
});

describe("Asset Search policy", () => {
  async function openPolicy(routes: Record<string, (body: unknown) => unknown>) {
    await mount({ "GET /api/projects/p1/research/sources": () => sourcesView([]), ...routes });
    await click(host.querySelector('[data-tab-id="policy"]'));
  }

  it("is labelled as global and switches the mode with a PUT", async () => {
    let policy: AssetSearchPolicy = policyFixture();
    await openPolicy({
      "GET /api/research/policy": () => policy,
      "PUT /api/research/policy": () => {
        policy = policyFixture({ mode: "any" });
        return policy;
      },
    });
    expect(host.textContent).toContain("Applies to all projects.");

    await click(host.querySelector('[role="radio"][aria-checked="false"]'));

    expect(requests).toContainEqual({
      method: "PUT",
      url: "/api/research/policy",
      body: { mode: "any" },
    });
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      "Any source",
    );
    expect(
      host.querySelector('[data-testid="asset-search-mode-description"]')?.textContent,
    ).toContain("Provenance is still recorded");
  });

  it("reads the policy again when it was changed outside the panel (Turn on in the chat)", async () => {
    let policy: AssetSearchPolicy = policyFixture({
      websites: { readLinkedPages: true, fullAccess: false },
    });
    await openPolicy({ "GET /api/research/policy": () => policy });
    const fullAccess = () =>
      host.querySelector('[role="switch"][aria-label="Full access to linked sites"]');
    expect(fullAccess()?.getAttribute("aria-checked")).toBe("false");

    policy = policyFixture({ websites: { readLinkedPages: true, fullAccess: true } });
    await act(async () => {
      announceAssetSearchPolicyChanged();
      await settle();
    });

    expect(fullAccess()?.getAttribute("aria-checked")).toBe("true");
  });

  it("switches reading the pages you link in chat with a PUT of the websites group", async () => {
    let policy: AssetSearchPolicy = policyFixture();
    await openPolicy({
      "GET /api/research/policy": () => policy,
      "PUT /api/research/policy": () => policy,
    });
    const switchOf = () =>
      host.querySelector('[role="switch"][aria-label="Open links you send in chat"]');
    expect(switchOf()?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-websites-group]")?.textContent).toContain(
      "Only links from your own messages, plus other pages on the same site.",
    );

    policy = policyFixture({ websites: { readLinkedPages: false, fullAccess: false } });
    await click(switchOf());

    expect(requests).toContainEqual({
      method: "PUT",
      url: "/api/research/policy",
      body: { websites: { readLinkedPages: false } },
    });
    expect(switchOf()?.getAttribute("aria-checked")).toBe("false");
  });

  it("switches full access to linked sites with a PUT, and locks it while reading pages is off", async () => {
    let policy: AssetSearchPolicy = policyFixture();
    await openPolicy({
      "GET /api/research/policy": () => policy,
      "PUT /api/research/policy": () => policy,
    });
    const fullAccess = () =>
      host.querySelector('[role="switch"][aria-label="Full access to linked sites"]');
    expect(fullAccess()?.getAttribute("aria-checked")).toBe("false");
    expect(fullAccess()?.hasAttribute("data-disabled")).toBe(false);
    expect(host.querySelector("[data-websites-group]")?.textContent).toContain(
      "record its pages as video",
    );

    policy = policyFixture({ websites: { readLinkedPages: true, fullAccess: true } });
    await click(fullAccess());
    expect(requests).toContainEqual({
      method: "PUT",
      url: "/api/research/policy",
      body: { websites: { fullAccess: true } },
    });
    expect(fullAccess()?.getAttribute("aria-checked")).toBe("true");

    // Reading off: full access is shown off and cannot be switched, even though the stored value stays on.
    policy = policyFixture({ websites: { readLinkedPages: false, fullAccess: true } });
    await click(host.querySelector('[role="switch"][aria-label="Open links you send in chat"]'));
    expect(fullAccess()?.getAttribute("aria-checked")).toBe("false");
    expect(fullAccess()?.hasAttribute("data-disabled")).toBe(true);
  });

  it("keeps the switch where it was and shows the failure when the server refuses the change", async () => {
    await openPolicy({
      "GET /api/research/policy": () => policyFixture(),
      "PUT /api/research/policy": () =>
        new HttpReply(500, { error: { code: "internal", message: "Could not save the policy" } }),
    });
    const switchOf = () =>
      host.querySelector('[role="switch"][aria-label="Open links you send in chat"]');
    await click(switchOf());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save the policy",
    );
    expect(switchOf()?.getAttribute("aria-checked")).toBe("true");
  });

  it("turns a source off, and removes one only after confirming", async () => {
    await openPolicy({
      "GET /api/research/policy": () => policyFixture(),
      "PATCH /api/research/sources/wikimedia-commons": () =>
        policyFixture({ sources: [trustedSource({ enabled: false })] }),
      "DELETE /api/research/sources/wikimedia-commons": () =>
        policyFixture({ sources: [], removedBuiltIns: ["wikimedia-commons"] }),
      "POST /api/research/sources/restore": () => policyFixture(),
    });

    await click(host.querySelector('[role="switch"][aria-label="Use Wikimedia Commons"]'));
    expect(requests).toContainEqual({
      method: "PATCH",
      url: "/api/research/sources/wikimedia-commons",
      body: { enabled: false },
    });

    await click(button("Remove Wikimedia Commons"));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    await click(button("Remove"));
    expect(requests).toContainEqual({
      method: "DELETE",
      url: "/api/research/sources/wikimedia-commons",
      body: undefined,
    });

    await click(button("Restore built-in sources (1)"));
    expect(requests).toContainEqual({
      method: "POST",
      url: "/api/research/sources/restore",
      body: undefined,
    });
    expect(host.querySelector('[data-source-id="wikimedia-commons"]')).not.toBeNull();
  });

  it("adds a trusted website from the form and shows the server's refusal inline", async () => {
    let refuse = true;
    await openPolicy({
      "GET /api/research/policy": () => policyFixture(),
      "POST /api/research/sources": () =>
        refuse
          ? new HttpReply(400, {
              error: { code: "invalid_request", message: "“localhost” is not a public domain" },
            })
          : policyFixture({
              sources: [
                trustedSource(),
                trustedSource({
                  id: "src-1",
                  name: "City archive",
                  builtIn: false,
                  connector: "site",
                }),
              ],
            }),
    });

    await click(button("Add trusted source"));
    await type(
      host.querySelector<HTMLInputElement>('form input:not([type="checkbox"])'),
      "City archive",
    );
    await type(host.querySelector("form textarea"), "archive.example.org,\nmedia.example.org");
    await click(host.querySelector('form input[type="checkbox"]'));
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });

    expect(requests.at(-1)).toEqual({
      method: "POST",
      url: "/api/research/sources",
      body: {
        name: "City archive",
        domains: ["archive.example.org", "media.example.org"],
        kinds: ["picture", "audio"],
      },
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "“localhost” is not a public domain",
    );
    expect(host.querySelector("form")).not.toBeNull();

    refuse = false;
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector('[data-source-id="src-1"]')?.textContent).toContain("City archive");
  });
});
