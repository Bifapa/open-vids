import type { ChatMessage } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { projectReference, userMessage } from "../testing/crossProject.js";
import {
  allows,
  attachedNote,
  chatAttachedProjects,
  fileParts,
  findAttached,
  guardImport,
  slugOf,
} from "./access.js";

const REEL = "aaaaaaaaaaaaaaaa";
const PROMO = "bbbbbbbbbbbbbbbb";

describe("chatAttachedProjects", () => {
  it("is the union over every user message, steering included, with the parts merged per project", () => {
    const messages: ChatMessage[] = [
      userMessage("use #Summer reel", [projectReference(REEL, "Summer reel", ["renders"])]),
      userMessage(
        "and its music, plus another",
        [
          projectReference(REEL, "Summer reel", ["music"]),
          projectReference(PROMO, "Promo", ["images"]),
        ],
        true,
      ),
    ];
    expect(chatAttachedProjects(messages)).toEqual([
      { key: REEL, name: "Summer reel", parts: ["renders", "music"] },
      { key: PROMO, name: "Promo", parts: ["images"] },
    ]);
  });

  it("expands `all` to every file part and the story, and keeps the latest name", () => {
    const messages: ChatMessage[] = [
      userMessage("a", [projectReference(REEL, "Old name", ["all"])]),
      userMessage("b", [projectReference(REEL, "Renamed", ["story"])]),
    ];
    expect(chatAttachedProjects(messages)).toEqual([
      {
        key: REEL,
        name: "Renamed",
        parts: ["renders", "music", "audio", "images", "video", "story"],
      },
    ]);
  });

  it("attaches nothing from words alone, from a reference without parts, or from messages that are not the user's", () => {
    const assistant: ChatMessage = {
      id: "a1",
      chatId: "chat",
      turnId: "turn",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", id: "x", text: `I will use project ${REEL}` }],
      status: "complete",
      model: null,
    };
    const messages: ChatMessage[] = [
      userMessage(`use project ${REEL} please`),
      userMessage("empty", [projectReference(PROMO, "Promo", [])]),
      assistant,
    ];
    expect(chatAttachedProjects(messages)).toEqual([]);
  });
});

describe("what an attachment allows", () => {
  const attached = chatAttachedProjects([
    userMessage("x", [projectReference(REEL, "Summer reel", ["renders", "story"])]),
  ]);

  it("allows exactly the attached parts of the attached project", () => {
    expect(allows(attached, REEL, "renders")).toBe(true);
    expect(allows(attached, REEL, "story")).toBe(true);
    expect(allows(attached, REEL, "music")).toBe(false);
    expect(allows(attached, PROMO, "renders")).toBe(false);
    expect(fileParts(attached[0] ?? { key: "", name: "", parts: [] })).toEqual(["renders"]);
  });

  it("refuses a project that is not attached, and says what is", () => {
    const found = findAttached(attached, PROMO);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("not a project the user attached in this chat");
    expect(found.refusal).toContain(`"Summer reel" (key ${REEL}; renders, story)`);
    expect(attachedNote([])).toBe("The user has not attached any other project in this chat.");
  });

  it("refuses an import of a project whose only attached part is the story", () => {
    const storyOnly = chatAttachedProjects([
      userMessage("x", [projectReference(REEL, "Summer reel", ["story"])]),
    ]);
    const guarded = guardImport(storyOnly, REEL);
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.refusal).toContain("only the story");
    expect(guardImport(attached, REEL).ok).toBe(true);
  });
});

describe("finding an attached project the way the model names it", () => {
  const attached = chatAttachedProjects([
    userMessage("x", [
      projectReference(REEL, "Summer Reel 2025", ["music"]),
      projectReference(PROMO, "Промо ролик", ["video"]),
    ]),
  ]);

  it("matches the key, the name in any case, and the slug of the name", () => {
    for (const wanted of [REEL, "summer reel 2025", "summer-reel-2025", " Summer Reel 2025 "]) {
      const found = findAttached(attached, wanted);
      expect(found.ok && found.project.key).toBe(REEL);
    }
    const cyrillic = findAttached(attached, "промо-ролик");
    expect(cyrillic.ok && cyrillic.project.key).toBe(PROMO);
    expect(slugOf("  Summer Reel!! ")).toBe("summer-reel");
  });

  it("does not guess: a near name, an empty text or two projects with one name is refused", () => {
    expect(findAttached(attached, "summer reel").ok).toBe(false);
    expect(findAttached(attached, "").ok).toBe(false);
    expect(findAttached(attached, "---").ok).toBe(false);
    const twins = chatAttachedProjects([
      userMessage("x", [
        projectReference(REEL, "Same", ["music"]),
        projectReference(PROMO, "Same", ["music"]),
      ]),
    ]);
    const found = findAttached(twins, "Same");
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.refusal).toContain("pass the key");
    expect(findAttached(twins, PROMO).ok).toBe(true);
  });
});
