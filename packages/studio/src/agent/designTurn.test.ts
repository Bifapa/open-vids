import { describe, expect, it } from "vitest";
import { parseDesignActionOptions, parseStartTurn } from "@hyperframes/agent-protocol";
import { assistantMessage, chatState, summary, turn, userMessage } from "./agentTestHarness";
import { designTurnRequest, type DesignTurnSpec } from "./designTurn";
import { retryTurnRequest } from "./retryTurn";

const SPECS: { name: string; spec: DesignTurnSpec; prompt: string; options: object }[] = [
  {
    name: "a brief is the prompt itself",
    spec: { action: "create", source: "scratch", brief: "  Calm editorial look  " },
    prompt: "Calm editorial look",
    options: { source: "scratch" },
  },
  {
    name: "this project",
    spec: { action: "create", source: "project" },
    prompt: "Create a design system from this project.",
    options: { source: "project" },
  },
  {
    name: "this project with notes",
    spec: { action: "create", source: "project", notes: " Keep it warm " },
    prompt: "Create a design system from this project.\n\nKeep it warm",
    options: { source: "project" },
  },
  {
    name: "a video",
    spec: { action: "create", source: "video", video: "assets/promo.mp4" },
    prompt: "Create a design system from the video “assets/promo.mp4”.",
    options: { source: "video", video: "assets/promo.mp4" },
  },
  {
    name: "a website",
    spec: { action: "create", source: "website", url: "https://example.com" },
    prompt: "Create a design system from the website https://example.com.",
    options: { source: "website", url: "https://example.com" },
  },
  {
    name: "another project",
    spec: {
      action: "create",
      source: "external_project",
      projectKey: "k-1",
      projectName: "Summer trip",
    },
    prompt: "Create a design system from the project “Summer trip”.",
    options: { source: "external_project", projectKey: "k-1" },
  },
  {
    name: "an edit of a library system",
    spec: { action: "edit", systemId: "sunset", instruction: "Make the accent warmer" },
    prompt: "Make the accent warmer",
    options: { systemId: "sunset" },
  },
];

describe("designTurnRequest", () => {
  it.each(SPECS)(
    "builds the turn for $name, and the server accepts it",
    ({ spec, prompt, options }) => {
      const request = designTurnRequest(spec, undefined, "en");
      expect(request).toEqual({
        prompt,
        designAction: spec.action,
        designOptions: options,
        editorContext: undefined,
        userLanguage: "en",
      });
      // The protocol's own parser is the judge of what a design turn may carry.
      expect(parseStartTurn(request)).toMatchObject({ ok: true });
      expect(parseDesignActionOptions(request.designOptions, spec.action)).toMatchObject({
        ok: true,
      });
    },
  );

  it("does not set a mode, intent or story fields: the chat's own settings apply", () => {
    const request = designTurnRequest({ action: "create", source: "project" }, undefined);
    expect(request).not.toHaveProperty("mode");
    expect(request).not.toHaveProperty("intent");
    expect(request).not.toHaveProperty("storyAction");
    expect(request).not.toHaveProperty("userLanguage");
  });
});

describe("retryTurnRequest", () => {
  it("runs a failed design turn again with its action and options, and no intent", () => {
    const chat = chatState({
      chat: summary({ status: "failed" }),
      messages: [
        userMessage("m1", "Create a design system from the website https://example.com."),
        assistantMessage({ status: "failed" }),
      ],
      turns: [
        turn({
          status: "failed",
          checkpoint: null,
          intent: "edit",
          designAction: "create",
          designOptions: { source: "website", url: "https://example.com" },
        }),
      ],
    });
    expect(retryTurnRequest(chat, chat.turns[0])).toEqual({
      prompt: "Create a design system from the website https://example.com.",
      designAction: "create",
      designOptions: { source: "website", url: "https://example.com" },
    });
  });

  it("carries an edit's system and leaves an ordinary turn without design fields", () => {
    const edit = chatState({
      messages: [userMessage("m1", "Warmer accent"), assistantMessage({ status: "failed" })],
      turns: [
        turn({
          status: "failed",
          checkpoint: null,
          designAction: "edit",
          designOptions: { systemId: "sunset" },
        }),
      ],
    });
    expect(retryTurnRequest(edit, edit.turns[0])).toMatchObject({
      designAction: "edit",
      designOptions: { systemId: "sunset" },
    });

    const plain = chatState({
      messages: [userMessage("m1", "Trim the intro"), assistantMessage({ status: "failed" })],
      turns: [turn({ status: "failed", checkpoint: null, intent: "edit" })],
    });
    const request = retryTurnRequest(plain, plain.turns[0]);
    expect(request).toEqual({ prompt: "Trim the intro", intent: "edit" });
  });
});
