import {
  STORY_LIMITS,
  type StoryOfferChapter,
  type StoryOperation,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { storyOfferOperations } from "./storyOffer.js";

const missingNodes = (operations: StoryOperation[]) =>
  operations.flatMap((operation) =>
    operation.op === "add_node" && operation.node.kind === "missing" ? [operation.node] : [],
  );

describe("storyOfferOperations: material the chapters name", () => {
  it("creates Missing Asset nodes for the music, sound effects and footage a chapter names, attached to it, and keeps the B-roll text", () => {
    const material =
      "calm piano music; a whoosh sound effect and stock footage of the city at night; a logo sting";
    const operations = storyOfferOperations([
      { title: "Intro" },
      { title: "City", material, durationSeconds: 20 },
      { title: "Outro" },
    ]);
    const nodes = missingNodes(operations);
    expect(nodes.map((node) => [node.mediaKind, node.need])).toEqual([
      ["music", "calm piano music"],
      ["sfx", "a whoosh sound effect"],
      ["video", "stock footage of the city at night"],
    ]);
    // Music scores the whole chapter and gets its length; the effect plays at the start, footage in the middle.
    expect(nodes[0]).toMatchObject({ neededDuration: 20 });
    expect(nodes[1]).not.toHaveProperty("neededDuration");
    expect(
      operations.filter((operation) => operation.op === "attach").map((operation) => operation),
    ).toEqual([
      { op: "attach", node: "@need-1", chapter: "@chapter-2", placement: "throughout" },
      { op: "attach", node: "@need-2", chapter: "@chapter-2", placement: "start" },
      { op: "attach", node: "@need-3", chapter: "@chapter-2", placement: "middle" },
    ]);
    const chapter = operations.find(
      (operation) => operation.op === "add_node" && operation.ref === "chapter-2",
    );
    expect(chapter).toMatchObject({ node: { kind: "chapter", bRoll: material } });
  });

  it("understands Russian wording, names a bare «музыка» after its chapter, and leaves pictures and prose alone", () => {
    const operations = storyOfferOperations([
      { title: "Старт", material: "музыка, звук запуска ракеты; фото из архива" },
      { title: "Финал", material: "кадры города ночью" },
      { title: "Титры", material: "красивые титры" },
    ]);
    expect(missingNodes(operations).map((node) => [node.mediaKind, node.title, node.need])).toEqual(
      [
        ["music", "Музыка · Старт", "музыка (Старт)"],
        ["sfx", "Звук запуска ракеты", "звук запуска ракеты"],
        ["video", "Кадры города ночью", "кадры города ночью"],
      ],
    );
  });

  it("yields at most three needs per chapter, without duplicates, and nothing for a chapter without material", () => {
    const operations = storyOfferOperations([
      { title: "A", material: "music; music; sound effects; footage of a lake; b-roll of a river" },
      { title: "B" },
    ]);
    expect(missingNodes(operations).map((node) => node.mediaKind)).toEqual([
      "music",
      "sfx",
      "video",
    ]);
    expect(
      operations.filter((operation) => operation.op === "attach").map((operation) => operation),
    ).toHaveLength(3);
  });

  it("stays inside the operation cap of one batch and never drops a chapter for material", () => {
    const chapters: StoryOfferChapter[] = Array.from({ length: 12 }, (_, index) => ({
      title: `Part ${index + 1}`,
      material: "calm music; a whoosh sound effect; stock footage of the sea",
    }));
    const operations = storyOfferOperations(chapters);
    expect(operations.length).toBeLessThanOrEqual(STORY_LIMITS.operations);
    expect(
      operations.filter(
        (operation) => operation.op === "add_node" && operation.node.kind === "chapter",
      ),
    ).toHaveLength(12);
    expect(operations.filter((operation) => operation.op === "connect")).toHaveLength(11);
    // Every material node has its attachment.
    expect(missingNodes(operations).length).toBe(
      operations.filter((operation) => operation.op === "attach").length,
    );
  });
});
