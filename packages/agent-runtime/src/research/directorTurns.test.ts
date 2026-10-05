import { describe, expect, it } from "vitest";
import {
  RESEARCH_LIMITS,
  type PermissionDecision,
  type PermissionPart,
  type PermissionRequest,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { isQaClosing } from "../qa/harness.js";
import { ccBy, sampleCandidate } from "../testing/research.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { ResearchToolError } from "./host.js";

/** Turn-level proof that a chat without Research gives its work, with every approval, to the Director. */

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

/** The permission cards of the turn's main message, in the order they were shown. */
function cards(fixture: RuntimeFixture, chatId: string): PermissionPart[] {
  const state = fixture.chats.get(chatId);
  const turn = state?.turns.at(-1);
  const message = state?.messages.find((entry) => entry.id === turn?.assistantMessageId);
  if (!message || message.role !== "assistant") return [];
  return message.parts.filter((part): part is PermissionPart => part.type === "permission");
}

/** Waits for the pending card of `kind` and answers it as the user would. */
async function answer(
  fixture: RuntimeFixture,
  chatId: string,
  turnId: string,
  kind: PermissionRequest["kind"],
  decision: PermissionDecision,
): Promise<PermissionRequest> {
  const pending = () =>
    cards(fixture, chatId).find(
      (part) => part.permission.kind === kind && part.permission.state === "pending",
    );
  await waitUntil(() => pending() !== undefined, `the ${kind} card`);
  const card = pending();
  if (!card) throw new Error(`no pending ${kind} card`);
  return (await fixture.turns.answerPermission(chatId, turnId, card.permission.id, decision))
    .permission;
}

describe("a chat without Research: the Director searches and imports", () => {
  it("asks the same download card as Research would, in the main message, and imports as the Director once allowed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.searchCandidates = [sampleCandidate("cand-1")];
      const chat = await fixture.chats.create({}, ["editor"]);
      const results: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || session.input.agent !== "director" || results.length > 0)
          return "completed";
        await session.callTool("search_assets", { query: "waves", mediaKind: "video" });
        results.push((await session.callTool("import_asset", { candidate: "cand-1" })).text);
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });

      const card = await answer(fixture, chat.id, turn.id, "asset_download", "once");
      expect(card).toMatchObject({
        kind: "asset_download",
        action: "download",
        agent: "director",
        asset: { title: "Ocean waves", source: "Wikimedia Commons", license: "CC BY 4.0" },
      });
      await settled(fixture, chat.id);

      expect(results[0]).toContain("Imported ");
      expect(fixture.research.importRequests).toEqual([
        expect.objectContaining({
          candidate: "cand-1",
          agent: "director",
          turnId: turn.id,
        }),
      ]);
      // No Research run was started: the Director did the work in its own message.
      expect(fixture.backend.sessionsOf("research")).toEqual([]);
      expect(fixture.chats.get(chat.id)?.runs).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses the import, without a server call, when the user declines the download card", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.searchCandidates = [sampleCandidate("cand-1")];
      const chat = await fixture.chats.create({}, ["editor"]);
      const results: HostToolResult[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || results.length > 0) return "completed";
        await session.callTool("search_assets", { query: "waves", mediaKind: "video" });
        results.push(await session.callTool("import_asset", { candidate: "cand-1" }));
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      await answer(fixture, chat.id, turn.id, "asset_download", "deny");
      await settled(fixture, chat.id);
      expect(results[0]).toMatchObject({ isError: true });
      expect(fixture.research.importRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks the restricted-license card for the asset on top of the download card, naming it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.searchCandidates = [
        sampleCandidate("nc-1", {
          title: "Sunset",
          license: ccBy({ id: "cc_by_nc", name: "CC BY-NC 4.0", status: "restricted" }),
        }),
      ];
      const chat = await fixture.chats.create({}, ["editor"]);
      const results: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || results.length > 0) return "completed";
        await session.callTool("search_assets", { query: "sunset", mediaKind: "video" });
        results.push((await session.callTool("import_asset", { candidate: "nc-1" })).text);
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a sunset" });
      await answer(fixture, chat.id, turn.id, "asset_download", "once");
      const restricted = await answer(fixture, chat.id, turn.id, "restricted_asset", "once");
      expect(restricted).toMatchObject({
        kind: "restricted_asset",
        agent: "director",
        asset: { title: "Sunset", license: "CC BY-NC 4.0" },
      });
      await settled(fixture, chat.id);

      expect(results[0]).toContain("Imported ");
      expect(fixture.research.importRequests[0]).toMatchObject({
        candidate: "nc-1",
        allowRestricted: true,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks after the server's refusal when the candidate was not known to be restricted, and stops on Don't allow", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
      const chat = await fixture.chats.create({}, ["editor"]);
      fixture.research.nextError = new ResearchToolError("restricted_license", "restricted", {
        title: "Rain loop",
        license: "CC BY-ND 4.0",
        source: "Flickr",
      });
      const results: HostToolResult[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || results.length > 0) return "completed";
        results.push(
          await session.callTool("import_asset", { url: "https://example.com/rain.mp4" }),
        );
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Add rain from example.com" });
      const card = await answer(fixture, chat.id, turn.id, "restricted_asset", "deny");
      expect(card.asset).toEqual({ title: "Rain loop", source: "Flickr", license: "CC BY-ND 4.0" });
      await settled(fixture, chat.id);

      expect(results[0]).toMatchObject({ isError: true });
      // One attempt reached the server (it refused); nothing was retried after the decline.
      expect(fixture.research.importRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("caps the imports of a turn for the Director too, and says what to report", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
      const chat = await fixture.chats.create({}, ["editor"]);
      const results: HostToolResult[] = [];
      // How many imports the Director's next prompt makes (once).
      let toImport = RESEARCH_LIMITS.importsPerTurn + 1;
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        const count = toImport;
        toImport = 0;
        for (let index = 0; index < count; index += 1) {
          results.push(
            await session.callTool("import_asset", {
              url: `https://example.com/clip-${index}.mp4`,
            }),
          );
        }
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Add every clip from example.com" });
      await settled(fixture, chat.id);

      expect(results).toHaveLength(RESEARCH_LIMITS.importsPerTurn + 1);
      expect(results.slice(0, -1).every((result) => result.isError !== true)).toBe(true);
      expect(results.at(-1)).toMatchObject({
        isError: true,
        text: expect.stringContaining("Import limit reached"),
      });
      expect(fixture.research.importRequests).toHaveLength(RESEARCH_LIMITS.importsPerTurn);
      // The count is the turn's: the next turn starts again from zero.
      results.length = 0;
      toImport = 1;
      await fixture.turns.start(chat.id, { prompt: "One more clip from example.com" });
      await settled(fixture, chat.id);
      expect(results.at(-1)).not.toMatchObject({ isError: true });
    } finally {
      await fixture.cleanup();
    }
  });
});
