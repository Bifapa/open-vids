// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest } from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import {
  assistantMessage,
  chatState,
  permissionPart,
  permissionRequest,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { onAssetSearchPolicyChanged } from "../../research/policyChanges";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

/** A running turn whose reply carries one permission card. */
function open(overrides: Partial<PermissionRequest> = {}) {
  const chat = chatState({
    chat: summary({ status: "working" }),
    messages: [userMessage(), assistantMessage({ parts: [permissionPart(overrides)] })],
    turns: [turn()],
  });
  mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat });
  return mounted;
}

const card = () => document.body.querySelector('[data-testid="permission-card"]');
const status = () => card()?.querySelector('[data-testid="permission-status"]')?.textContent;
const buttons = () => [...(card()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const ASSET = { title: "Epic orchestral loop", source: "Openverse", license: "CC0" };

/** A pending request to download outside material, as Research's candidate describes it. */
function openDownload(overrides: Partial<PermissionRequest> = {}) {
  return open({
    kind: "asset_download",
    action: "download",
    site: null,
    asset: ASSET,
    ...overrides,
  });
}

const sentence = () => card()?.querySelector('[data-testid="permission-sentence"]')?.textContent;
const licenseLine = () => card()?.querySelector('[data-testid="permission-license"]')?.textContent;

describe("a pending permission card", () => {
  it("names who asked, what for and the setting, with the three answers", () => {
    const { host } = open();
    expect(card()?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(card()?.textContent).toContain("Full access to linked sites is off");
    expect(card()?.querySelector('[data-testid="permission-sentence"]')?.textContent).toBe(
      "Research wants to download a file from openvids.ai",
    );
    // The setting is worded as in Settings, not a second copy.
    const setting = card()?.querySelector('[data-testid="permission-setting"]')?.textContent;
    expect(setting).toContain("Full access to linked sites");
    expect(setting).toContain("read its code and record its pages as video");
    expect(setting).toContain("Settings → Asset Search → Websites");
    expect(buttons()).toEqual(["Allow once", "Turn on", "Don't allow"]);
    expect(host.querySelector('[data-testid="permission-status"]')).toBeNull();
  });

  it("words the reading setting and an unknown site", () => {
    open({ kind: "read_linked_pages", action: "read", site: null, agent: "director" });
    expect(card()?.textContent).toContain("Reading websites is off");
    expect(card()?.querySelector('[data-testid="permission-sentence"]')?.textContent).toBe(
      "Main wants to open a page you linked",
    );
    expect(card()?.querySelector('[data-testid="permission-setting"]')?.textContent).toContain(
      "Open links you send in chat",
    );
  });

  it.each<[PermissionDecision, string, string]>([
    ["once", "Allow once", "Allowed once"],
    ["always", "Turn on", "Turned on"],
    ["deny", "Don't allow", "Not allowed"],
  ])("sends %s and settles into a status line", async (decision, label, statusText) => {
    const { client, host } = open();
    await click(buttonWithText(host, label));
    expect(client.answerPermission).toHaveBeenCalledWith("c1", "t1", "perm1", decision);
    expect(status()).toBe(statusText);
    expect(buttons()).toEqual([]);
  });

  it("stays busy until the runtime answers, with every answer disabled", async () => {
    const { client, host } = open();
    const { promise, resolve } = Promise.withResolvers<{ permission: PermissionRequest }>();
    client.answerPermission.mockReturnValueOnce(promise);
    await click(buttonWithText(host, "Turn on"));
    const all = [...(card()?.querySelectorAll("button") ?? [])];
    expect(all.every((button) => button.disabled)).toBe(true);
    await click(all[0]);
    expect(client.answerPermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ permission: permissionRequest({ state: "enabled" }) });
    });
    expect(status()).toBe("Turned on");
  });

  it("shows a failed answer inline and retries the same answer", async () => {
    const { client, host } = open();
    client.answerPermission.mockRejectedValueOnce(new AgentApiError("network", "offline"));
    await click(buttonWithText(host, "Allow once"));
    const error = card()?.querySelector('[role="alert"]');
    expect(error?.textContent).toContain("Couldn’t send your answer.");
    expect(buttons()).toContain("Allow once");

    await click(buttonWithText(error as HTMLElement, "Try again"));
    expect(client.answerPermission).toHaveBeenCalledTimes(2);
    expect(client.answerPermission).toHaveBeenLastCalledWith("c1", "t1", "perm1", "once");
    expect(card()?.querySelector('[role="alert"]')).toBeNull();
    expect(status()).toBe("Allowed once");
  });

  it.each<[PermissionDecision, string, number]>([
    ["once", "Allow once", 0],
    ["deny", "Don't allow", 0],
    ["always", "Turn on", 1],
  ])(
    "%s tells the Asset Search views to read the policy again only when the setting is turned on",
    async (_decision, label, announced) => {
      const changed = vi.fn();
      const stop = onAssetSearchPolicyChanged(changed);
      try {
        const { host } = open();
        await click(buttonWithText(host, label));
        expect(changed).toHaveBeenCalledTimes(announced);
      } finally {
        stop();
      }
    },
  );
});

describe("an answered permission card", () => {
  it.each<[PermissionRequest["state"], string]>([
    ["allowed_once", "Allowed once"],
    ["enabled", "Turned on"],
    ["denied", "Not allowed"],
    ["expired", "The turn ended before an answer"],
  ])("shows %s as a status line without buttons", (state, text) => {
    open({ state, answeredAt: 5000 });
    expect(card()?.getAttribute("data-permission-state")).toBe(state);
    expect(status()).toBe(text);
    expect(buttons()).toEqual([]);
    expect(card()?.querySelector('[data-testid="permission-setting"]')).toBeNull();
    // The heading names the setting; "… is off" would contradict "Turned on" / "Allowed once" below it.
    expect(card()?.textContent).toContain("Full access to linked sites");
    expect(card()?.textContent).not.toContain("is off");
  });

  it.each<[PermissionRequest["state"], string]>([
    ["allowed_once", "Allowed for this turn"],
    ["enabled", "Asking turned off"],
    ["denied", "Not allowed"],
    ["expired", "The turn ended before an answer"],
  ])("shows a download request as %s without buttons", (state, text) => {
    openDownload({ state, answeredAt: 5000 });
    expect(status()).toBe(text);
    expect(buttons()).toEqual([]);
    expect(card()?.querySelector('[data-testid="permission-setting"]')).toBeNull();
    expect(card()?.querySelector('[data-testid="permission-license"]')).toBeNull();
    // The record still says what was downloaded; "needs your OK" would contradict the status under it.
    expect(card()?.textContent).toContain("Downloading material");
    expect(card()?.textContent).not.toContain("needs your OK");
    expect(sentence()).toBe("Research wants to download Epic orchestral loop from Openverse");
  });

  it("drops a permission part the runtime worded in a way this Studio does not know", () => {
    const chat = chatState({
      messages: [
        userMessage(),
        assistantMessage({
          parts: [
            {
              type: "permission",
              id: "perm-x",
              permission: Object.assign(permissionRequest(), { kind: "mystery" }),
            },
          ],
        }),
      ],
      turns: [turn({ status: "completed" })],
    });
    mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat });
    expect(card()).toBeNull();
  });

  it("drops a download request whose material is damaged", () => {
    const chat = chatState({
      messages: [
        userMessage(),
        assistantMessage({
          parts: [
            {
              type: "permission",
              id: "perm-y",
              permission: Object.assign(permissionRequest({ kind: "asset_download" }), {
                asset: { title: 7 },
              }),
            },
          ],
        }),
      ],
      turns: [turn({ status: "completed" })],
    });
    mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat });
    expect(card()).toBeNull();
  });
});

describe("a pending download permission card", () => {
  it("names the material, where it comes from, its license and the setting, with the three answers", () => {
    const { host } = openDownload();
    expect(card()?.getAttribute("data-permission-kind")).toBe("asset_download");
    expect(card()?.textContent).toContain("Downloading material needs your OK");
    expect(sentence()).toBe("Research wants to download Epic orchestral loop from Openverse");
    expect(licenseLine()).toBe("License: CC0");
    // The Autonomy toggle as Settings words it, not a second copy, and where it lives.
    const setting = card()?.querySelector('[data-testid="permission-setting"]')?.textContent;
    expect(setting).toContain("Ask before downloading assets");
    expect(setting).toContain("Agents list what they found and wait for your approval.");
    expect(setting).toContain("Settings → Execution → Autonomy");
    expect(buttons()).toEqual(["Allow for this turn", "Don't ask again", "Don't allow"]);
    expect(host.querySelector('[data-testid="permission-status"]')).toBeNull();
  });

  it.each<[string, string | null]>([
    ["a license that is null", null],
    ["a blank license", "  "],
  ])("says so when the license is not known (%s)", (_name, license) => {
    openDownload({ asset: { ...ASSET, license } });
    expect(licenseLine()).toBe("License unknown");
  });

  it.each<[string, Partial<PermissionRequest>, string]>([
    [
      "no source",
      { asset: { ...ASSET, source: null } },
      "Research wants to download Epic orchestral loop",
    ],
    [
      "no source but the site",
      { asset: { ...ASSET, source: null }, site: "pixabay.com" },
      "Research wants to download Epic orchestral loop from pixabay.com",
    ],
    [
      "no title",
      { asset: { ...ASSET, title: " " } },
      "Research wants to download material from Openverse",
    ],
    [
      "no asset but the site",
      { asset: undefined, site: "pixabay.com", agent: "director" },
      "Main wants to download material from pixabay.com",
    ],
    [
      "nothing known",
      { asset: undefined },
      "Research wants to download material from outside the project",
    ],
  ])("words the sentence with %s", (_name, overrides, text) => {
    openDownload(overrides);
    expect(sentence()).toBe(text);
  });

  it("shows no license line when the request carries no material", () => {
    openDownload({ asset: undefined, site: "pixabay.com" });
    expect(card()?.querySelector('[data-testid="permission-license"]')).toBeNull();
  });

  it("shows a title that looks like markup as plain text", () => {
    openDownload({ asset: { ...ASSET, title: "<b>Loud</b> <br/> {agent}", source: "<i>x</i>" } });
    expect(sentence()).toBe("Research wants to download <b>Loud</b> <br/> {agent} from <i>x</i>");
    // Only the agent and the two names are bold; nothing the title says became an element.
    expect(card()?.querySelectorAll('[data-testid="permission-sentence"] b')).toHaveLength(3);
    expect(card()?.querySelector('[data-testid="permission-sentence"] br')).toBeNull();
  });

  it.each<[PermissionDecision, string, string]>([
    ["once", "Allow for this turn", "Allowed for this turn"],
    ["always", "Don't ask again", "Asking turned off"],
    ["deny", "Don't allow", "Not allowed"],
  ])("sends %s and settles into a status line", async (decision, label, statusText) => {
    const { client, host } = openDownload();
    await click(buttonWithText(host, label));
    expect(client.answerPermission).toHaveBeenCalledWith("c1", "t1", "perm1", decision);
    expect(card()?.getAttribute("data-permission-kind")).toBe("asset_download");
    expect(status()).toBe(statusText);
    expect(buttons()).toEqual([]);
    expect(card()?.textContent).toContain("Downloading material");
    expect(card()?.textContent).not.toContain("needs your OK");
  });

  it.each<[PermissionDecision, string, number]>([
    ["once", "Allow for this turn", 0],
    ["deny", "Don't allow", 0],
    ["always", "Don't ask again", 1],
  ])(
    "%s reads the agent settings again only when asking was turned off, and leaves the Asset Search policy alone",
    async (_decision, label, reads) => {
      const changed = vi.fn();
      const stop = onAssetSearchPolicyChanged(changed);
      try {
        const { client, host } = openDownload();
        await click(buttonWithText(host, label));
        expect(client.getSettings).toHaveBeenCalledTimes(reads);
        expect(changed).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
