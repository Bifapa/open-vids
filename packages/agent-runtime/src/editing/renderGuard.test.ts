import { describe, expect, it } from "vitest";
import type { HostToolResult } from "../backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { FakeEditingHost } from "../testing/editing.js";
import { TurnEditing } from "./executor.js";
import { LONG_RENDER_SECONDS, asksForRender } from "./renderGuard.js";

describe("asksForRender", () => {
  it("recognises an explicit request for a render, an export or a video file in English and Russian", () => {
    for (const text of [
      "Render the video",
      "please render it in high quality",
      "Export it to mp4",
      "I need the final video file",
      "rendering is fine, go ahead",
      "Отрендери видео",
      "Сделай рендер в высоком качестве",
      "Экспортируй ролик",
      "Выгрузи финальный файл",
      "Собери финальное видео",
    ]) {
      expect(asksForRender(text), text).toBe(true);
    }
  });

  it("ignores edits, story actions and requests that refuse a render", () => {
    for (const text of [
      "Build the story",
      "Review the story",
      "Tighten the raw talk and remove pauses",
      "Убери паузы и плохие дубли",
      "Don't render it yet",
      "do not export anything",
      "without rendering please",
      "Не рендери пока",
      "Без экспорта, просто смонтируй",
      "surrender the intro",
    ]) {
      expect(asksForRender(text), text).toBe(false);
    }
  });
});

function editingOf(host: FakeEditingHost, userRequests: string[]) {
  const turn = new AbortController();
  const executor = new TurnEditing({ host, turnSignal: turn.signal, userRequests });
  return {
    executor,
    render: (args: unknown = {}): Promise<HostToolResult> =>
      executor.execute("render_video", args, new AbortController().signal),
  };
}

function compositionOf(host: FakeEditingHost, duration: number): void {
  host.timelineResult = {
    ...host.timelineResult,
    composition: { ...host.timelineResult.composition, duration },
  };
}

describe("render_video guard", () => {
  it("refuses a composition longer than 3 minutes when the user did not ask for a render, and offers it instead", async () => {
    const host = new FakeEditingHost();
    compositionOf(host, LONG_RENDER_SECONDS + 60);
    const { render } = editingOf(host, ["Tighten the raw talk"]);

    const result = await render();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Not rendered");
    expect(result.text).toContain("4 minutes long");
    expect(result.text).toContain("offer to render it");
    expect(host.renderRequests).toEqual([]);
  });

  it("renders a long composition when the turn's prompt asks for it, in English or Russian", async () => {
    for (const prompt of ["Cut the talk and render it", "Смонтируй и отрендери видео"]) {
      const host = new FakeEditingHost();
      compositionOf(host, 900);
      const { render } = editingOf(host, [prompt]);
      const result = await render({ quality: "draft" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("Rendered renders/final.mp4");
      expect(host.renderRequests).toEqual([{ quality: "draft" }]);
    }
  });

  it("accepts a render asked for by a steering message sent later in the turn", async () => {
    const host = new FakeEditingHost();
    compositionOf(host, 900);
    const { executor, render } = editingOf(host, ["Tighten the raw talk"]);
    expect((await render()).isError).toBe(true);

    executor.noteUserRequest("actually, export it now");
    expect((await render()).isError).toBeUndefined();
    expect(host.renderRequests).toHaveLength(1);
  });

  it("leaves short compositions alone, asked or not", async () => {
    const host = new FakeEditingHost();
    compositionOf(host, LONG_RENDER_SECONDS);
    const { render } = editingOf(host, ["Tighten the intro"]);
    expect((await render()).isError).toBeUndefined();
    expect(host.renderRequests).toHaveLength(1);
  });

  it("applies in a real Director turn: the long render is refused and the agent is told to offer it", async () => {
    const fixture: RuntimeFixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      compositionOf(fixture.editing, 1_200);
      const results: HostToolResult[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        results.push(await session.callTool("render_video", {}));
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk" });
      await waitUntil(() => results.length === 1, "the render attempt");
      expect(results[0]?.isError).toBe(true);
      expect(fixture.editing.renderRequests).toEqual([]);

      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");
      await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk and render it" });
      await waitUntil(() => results.length === 2, "the second render attempt");
      expect(results[1]?.isError).toBeUndefined();
      expect(fixture.editing.renderRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
