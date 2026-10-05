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
      "Save it as .mp4",
      "Send me the final video when it is ready",
      "Give me the finished clip",
      "Пришли готовый ролик",
      "Сделай мне финальное видео",
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
      "Убери паузы и плохие дубли в interview.mp4",
      "Remove the long pauses from talk.mp4",
      "trim my_clip-2.MP4 to the best minute",
      "Сделай видео короче",
      "render it later, not now",
      "No export for now, just trim the intro",
      "Не нужно экспортировать, только смонтируй",
    ]) {
      expect(asksForRender(text), text).toBe(false);
    }
  });

  it("does not take a remark about a render that already happened, or a question that only wonders, for a request", () => {
    for (const text of [
      "the last render took forever",
      "The export was slow yesterday",
      "I rendered it yesterday and it was fine",
      "we haven't exported it yet",
      "Export took ages",
      "how long does the export take?",
      "should I render it?",
      "did the render finish?",
      "how long will the render take",
      "Is the video file ready?",
      "почему рендер такой медленный?",
      "Рендер был слишком долгим",
      "прошлый экспорт получился тёмным",
      "в прошлый раз экспорт занял час",
      "Я уже экспортировал видео вчера",
    ]) {
      expect(asksForRender(text), text).toBe(false);
    }
  });

  it("still takes an imperative, a polite request or a wish, also later in the message", () => {
    for (const text of [
      "Render",
      "render it",
      "Fix the intro, then render it",
      "Trim the intro and export",
      "can you render it?",
      "Could you export the video please?",
      "let's export it now",
      "I want a render in 4K",
      "we need to export this today",
      "start the render",
      "ok, now render it",
      "Сделай рендер",
      "давай экспорт в mp4",
      "Теперь рендер, пожалуйста",
      "Нужен экспорт в 4K",
      "Можешь отрендерить?",
      "Смонтируй и экспортируй",
      "The last render took forever. Export it again.",
    ]) {
      expect(asksForRender(text), text).toBe(true);
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

  it("asks on a card in a real Director turn: denied is refused, allowed once renders, and a stated request needs no card", async () => {
    const fixture: RuntimeFixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      compositionOf(fixture.editing, 1_200);
      const results: HostToolResult[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("raw talk")) return "completed";
        results.push(await session.callTool("render_video", {}));
        return "completed";
      };
      const pending = () => {
        const parts = (fixture.chats.get(chat.id)?.messages ?? []).flatMap((message) =>
          message.role === "assistant" ? message.parts : [],
        );
        const part = parts.find(
          (entry) => entry.type === "permission" && entry.permission.state === "pending",
        );
        return part?.type === "permission" ? part.permission : null;
      };

      // The user did not ask for a render: the call shows a long_render card and waits for the answer.
      const first = await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk" });
      await waitUntil(() => pending() !== null, "the long render card");
      expect(pending()).toMatchObject({
        kind: "long_render",
        action: "render",
        render: { composition: "index.html", seconds: 1_200 },
      });
      await fixture.turns.answerPermission(chat.id, first.id, pending()?.id ?? "", "deny");
      await waitUntil(() => results.length === 1, "the declined render");
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.text).toContain("declined");
      expect(fixture.editing.renderRequests).toEqual([]);
      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");

      // Allowed once: the render goes ahead, and a second render of the same turn does not ask again.
      const second = await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk again" });
      await waitUntil(() => pending() !== null, "the second card");
      await fixture.turns.answerPermission(chat.id, second.id, pending()?.id ?? "", "once");
      await waitUntil(() => results.length === 2, "the allowed render");
      expect(results[1]?.isError).toBeUndefined();
      expect(fixture.editing.renderRequests).toHaveLength(1);
      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");

      // A request in words skips the card.
      await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk and render it" });
      await waitUntil(() => results.length === 3, "the asked-for render");
      expect(results[2]?.isError).toBeUndefined();
      expect(fixture.editing.renderRequests).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
