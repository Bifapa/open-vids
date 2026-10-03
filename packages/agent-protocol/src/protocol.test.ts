import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  LIMITS,
  PROVIDER_CREDENTIAL_SOURCES,
  SseParser,
  applyChatEvent,
  emptyChatState,
  encodeSseMessage,
  foldChatEvents,
  isNextEvent,
  isOAuthLoginId,
  isOAuthLoginState,
  isProviderId,
  normalizeChatIntent,
  parseAgentIntake,
  parseAnswerStoryOffer,
  parseReference,
  parseRevertTurn,
  parseSetJevApiKey,
  parseSetProviderApiKey,
  parseStartOAuthLogin,
  parseStartTurn,
  parseSteerTurn,
  parseSubmitOAuthLoginInput,
  parseUpdateAgentSettings,
  parseUpdateChat,
  type AgentRun,
  type AssistantMessage,
  type ChatEvent,
  type ChatSummary,
  type OAuthLoginState,
  type PermissionRequest,
  type StoryOffer,
  type TurnSummary,
} from "./index.js";

const chat: ChatSummary = {
  id: "c1",
  projectId: "p",
  title: "New chat",
  createdAt: 1,
  updatedAt: 1,
  status: "idle",
  lastTaskSummary: null,
  activeMode: "normal",
  mainAgentModel: null,
  thinking: null,
  enabledAgents: [],
};

const turn: TurnSummary = {
  id: "t1",
  chatId: "c1",
  status: "running",
  startedAt: 2,
  promptMessageId: "m1",
  assistantMessageId: "m2",
  model: null,
  thinking: null,
  checkpoint: null,
};

const assistant: AssistantMessage = {
  id: "m2",
  chatId: "c1",
  turnId: "t1",
  createdAt: 2,
  role: "assistant",
  parts: [],
  status: "streaming",
  model: null,
};

function log(): ChatEvent[] {
  const events: Omit<ChatEvent, "seq" | "chatId" | "ts">[] = [
    { type: "chat.created", chat },
    {
      type: "turn.started",
      turn,
      promptMessage: {
        id: "m1",
        chatId: "c1",
        turnId: "t1",
        createdAt: 2,
        role: "user",
        steering: false,
        parts: [{ type: "text", id: "p1", text: "hi" }],
      },
      assistantMessage: assistant,
    },
    { type: "thinking.updated", messageId: "m2", partId: "th", delta: "hm", done: false },
    { type: "thinking.updated", messageId: "m2", partId: "th", delta: "m", done: true },
    { type: "assistant.text.delta", messageId: "m2", partId: "tx", delta: "Hel" },
    { type: "assistant.text.delta", messageId: "m2", partId: "tx", delta: "lo" },
    {
      type: "activity.updated",
      messageId: "m2",
      activity: {
        id: "a1",
        category: "inspect",
        status: "running",
        label: "Reading 1 file",
        count: 1,
        targets: ["index.html"],
        startedAt: 3,
      },
    },
    { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
  ];
  return events.map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index }));
}

describe("applyChatEvent", () => {
  it("folds a streamed turn into messages, keeping part order and settling open parts", () => {
    const state = foldChatEvents(log());
    expect(state?.lastSeq).toBe(8);
    const message = state?.messages[1];
    expect(message?.role).toBe("assistant");
    if (message?.role !== "assistant") return;
    expect(message.status).toBe("complete");
    expect(message.parts.map((part) => part.type)).toEqual(["thinking", "text", "activity"]);
    const [thinking, text, activity] = message.parts;
    expect(thinking).toMatchObject({ text: "hmm", done: true, startedAt: 12, endedAt: 13 });
    expect(text).toMatchObject({ text: "Hello" });
    // a still-running activity is settled when the turn ends
    expect(activity).toMatchObject({ activity: { status: "done" } });
    expect(state?.turns[0]?.status).toBe("completed");
  });

  it("ignores replayed events and reports gaps", () => {
    const events = log();
    let state = emptyChatState(chat);
    state = applyChatEvent(state, events[0]!);
    const again = applyChatEvent(state, events[0]!);
    expect(again).toBe(state);
    expect(isNextEvent(state, events[1]!)).toBe(true);
    expect(isNextEvent(state, events[3]!)).toBe(false);
  });

  it("folds a permission request into its part and settles a pending one when the turn ends", () => {
    const request: PermissionRequest = {
      id: "perm-1",
      kind: "read_linked_pages",
      action: "read",
      site: "linear.app",
      agent: "director",
      state: "pending",
      requestedAt: 4,
    };
    const events: Omit<ChatEvent, "seq" | "chatId" | "ts">[] = [
      ...log().slice(0, 2),
      { type: "permission.updated", messageId: "m2", permission: request },
      {
        type: "permission.updated",
        messageId: "m2",
        permission: { ...request, state: "allowed_once", answeredAt: 5 },
      },
      { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
    ];
    const state = foldChatEvents(
      events.map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index })),
    );
    const message = state?.messages[1];
    if (message?.role !== "assistant") throw new Error("the assistant message is missing");
    expect(message.parts).toEqual([
      {
        type: "permission",
        id: "perm-1",
        permission: { ...request, state: "allowed_once", answeredAt: 5 },
      },
    ]);

    // A still-pending request cannot outlive its turn: the terminal event expires it.
    const open = foldChatEvents(
      [
        ...log().slice(0, 2),
        { type: "permission.updated", messageId: "m2", permission: request },
        { type: "turn.aborted", turn: { ...turn, status: "aborted", endedAt: 9 } },
      ].map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index })),
    );
    const aborted = open?.messages[1];
    if (aborted?.role !== "assistant") throw new Error("the assistant message is missing");
    expect(aborted.parts[0]).toMatchObject({ permission: { state: "expired" } });
  });

  it("folds a Story Mode offer into its part and keeps a pending one answerable after its turn ends", () => {
    const offer: StoryOffer = {
      id: "offer-1",
      chapters: [
        { title: "Старт ракеты" },
        { title: "Туманность Карина", summary: "фото из архива" },
        { title: "Финал с титрами", durationSeconds: 12, material: "музыка" },
      ],
      state: "pending",
      requestedAt: 4,
    };
    const state = foldChatEvents(
      [
        ...log().slice(0, 2),
        { type: "storyOffer.updated", messageId: "m2", offer },
        { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
      ].map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index })),
    );
    const message = state?.messages[1];
    if (message?.role !== "assistant") throw new Error("the assistant message is missing");
    // Unlike a permission, the offer stays pending: its card outlives the turn that made it.
    expect(message.parts).toEqual([{ type: "story-offer", id: "offer-1", offer }]);

    // The answer replaces the part in place, with the state the runtime wrote.
    const answered = applyChatEvent(state!, {
      type: "storyOffer.updated",
      messageId: "m2",
      offer: { ...offer, state: "accepted", answeredAt: 7 },
      seq: (state?.lastSeq ?? 0) + 1,
      chatId: "c1",
      ts: 30,
    });
    const after = answered.messages[1];
    if (after?.role !== "assistant") throw new Error("the assistant message is missing");
    expect(after.parts).toEqual([
      { type: "story-offer", id: "offer-1", offer: { ...offer, state: "accepted", answeredAt: 7 } },
    ]);
  });

  it("marks a failed turn's streaming message failed", () => {
    const events = log().slice(0, 5);
    const failed: ChatEvent = {
      type: "turn.failed",
      turn: { ...turn, status: "failed" },
      error: { code: "agent_failed", message: "boom" },
      seq: 6,
      chatId: "c1",
      ts: 20,
    };
    const state = foldChatEvents([...events, failed]);
    const message = state?.messages[1];
    expect(message?.role === "assistant" && message.status).toBe("failed");
  });

  describe("interim text parts", () => {
    const interim = (seq: number, partIds: string[], messageId = "m2"): ChatEvent => ({
      type: "assistant.parts.interim",
      messageId,
      partIds,
      seq,
      chatId: "c1",
      ts: 30,
    });
    const delta = (seq: number, partId: string, text: string): ChatEvent => ({
      type: "assistant.text.delta",
      messageId: "m2",
      partId,
      delta: text,
      seq,
      chatId: "c1",
      ts: 31,
    });
    const textParts = (events: ChatEvent[]) => {
      const message = foldChatEvents(events)?.messages[1];
      return message?.role === "assistant"
        ? message.parts.flatMap((part) => (part.type === "text" ? [part] : []))
        : [];
    };

    it("marks only the named text parts and keeps the mark when more text arrives", () => {
      const [created, started] = log();
      const events = [
        created!,
        started!,
        delta(3, "a", "Done! "),
        delta(4, "b", "Second."),
        interim(5, ["a", "missing", "th"]),
        delta(6, "a", "Ready."),
        delta(7, "c", "Final report."),
      ];
      expect(textParts(events)).toEqual([
        { type: "text", id: "a", text: "Done! Ready.", interim: true },
        { type: "text", id: "b", text: "Second." },
        { type: "text", id: "c", text: "Final report." },
      ]);
    });

    it("leaves logs without the event untouched", () => {
      const parts = textParts(log());
      expect(parts).toEqual([{ type: "text", id: "tx", text: "Hello" }]);
      expect("interim" in (parts[0] ?? {})).toBe(false);
    });

    it("ignores a mark for a message that does not exist", () => {
      const [created, started] = log();
      expect(
        textParts([created!, started!, delta(3, "a", "Hi"), interim(4, ["a"], "nope")]),
      ).toEqual([{ type: "text", id: "a", text: "Hi" }]);
    });
  });
});

describe("validators", () => {
  const context = {
    schemaVersion: 1,
    capturedAt: 5,
    project: { id: "p" },
    activeComposition: { path: "index.html", fps: 30 },
    timeline: {
      duration: 10,
      elementCount: 1,
      elements: [{ id: "a", tag: "div", start: 0, duration: 2, track: 0 }, { bad: true }],
    },
    playhead: { time: 1.5, playing: false },
    selection: {
      clips: [],
      assetPath: null,
      previewElement: { hfId: "x" },
      range: { start: 1, end: 2 },
    },
    renderSettings: null,
    storyGraph: null,
  };

  it("parses a start-turn request and drops malformed context clips", () => {
    const parsed = parseStartTurn({ prompt: "make it shorter", editorContext: context });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.editorContext?.timeline.elements).toHaveLength(1);
    expect(parsed.value.editorContext?.selection.range).toEqual({ start: 1, end: 2 });
  });

  it("carries the user's UI language on start and steer, and rejects a malformed tag", () => {
    const started = parseStartTurn({ prompt: "x", userLanguage: "ru" });
    expect(started.ok && started.value.userLanguage).toBe("ru");
    const steered = parseSteerTurn({ text: "x", userLanguage: "pt-BR" });
    expect(steered.ok && steered.value.userLanguage).toBe("pt-BR");
    const absent = parseStartTurn({ prompt: "x" });
    expect(absent.ok && "userLanguage" in absent.value).toBe(false);
    expect(parseStartTurn({ prompt: "x", userLanguage: "Russian!" }).ok).toBe(false);
    expect(parseSteerTurn({ text: "x", userLanguage: 7 }).ok).toBe(false);
  });

  it("rejects empty prompts and steering text", () => {
    expect(parseStartTurn({ prompt: "  " }).ok).toBe(false);
    expect(parseSteerTurn({ text: "" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", editorContext: { schemaVersion: 2 } }).ok).toBe(false);
  });

  it("accepts every reference kind and rejects malformed ones", () => {
    const ok = [
      { id: "1", kind: "image", source: { type: "project-path", path: "a.png" } },
      { id: "2", kind: "video", source: { type: "url", url: "https://x/y.mp4" } },
      { id: "3", kind: "audio", source: { type: "upload", uploadId: "u" } },
      { id: "4", kind: "file", source: { type: "project-path", path: "a.txt" } },
      { id: "5", kind: "url", url: "https://example.com" },
      { id: "6", kind: "asset", path: "assets/a.mp4" },
      { id: "7", kind: "timeline-range", start: 1, end: 2 },
      { id: "8", kind: "editor-selection", context },
    ];
    for (const reference of ok) expect(parseReference(reference).ok).toBe(true);
    expect(parseReference({ id: "x", kind: "timeline-range", start: 3, end: 1 }).ok).toBe(false);
    expect(parseReference({ id: "x", kind: "video", source: { type: "nope" } }).ok).toBe(false);
    expect(parseReference({ id: "x", kind: "hologram" }).ok).toBe(false);
  });

  it("keeps the size and length of an attached file, drops nonsense, and accepts references on steering", () => {
    const media = parseReference({
      id: "1",
      kind: "video",
      source: { type: "project-path", path: "a.mp4" },
      sizeBytes: 4096,
      durationSeconds: 12.5,
    });
    expect(media.ok && media.value).toMatchObject({ sizeBytes: 4096, durationSeconds: 12.5 });
    const asset = parseReference({ id: "2", kind: "asset", path: "a.pdf", sizeBytes: 10 });
    expect(asset.ok && asset.value).toMatchObject({ sizeBytes: 10 });
    const odd = parseReference({
      id: "3",
      kind: "image",
      source: { type: "project-path", path: "a.png" },
      sizeBytes: -1,
      durationSeconds: "long",
    });
    expect(odd.ok && "sizeBytes" in odd.value).toBe(false);
    expect(odd.ok && "durationSeconds" in odd.value).toBe(false);

    const steered = parseSteerTurn({
      text: "use this too",
      references: [{ id: "a", kind: "asset", path: "assets/logo.png" }],
    });
    expect(steered.ok && steered.value.references).toEqual([
      { id: "a", kind: "asset", path: "assets/logo.png" },
    ]);
    expect(parseSteerTurn({ text: "x", references: [{ id: "" }] }).ok).toBe(false);
  });

  it("carries the Auto frame-format hand-off on a start turn and on an intake, and refuses other values", () => {
    const started = parseStartTurn({ prompt: "x", canvas: "auto" });
    expect(started.ok && started.value.canvas).toBe("auto");
    const absent = parseStartTurn({ prompt: "x" });
    expect(absent.ok && "canvas" in absent.value).toBe(false);
    expect(parseStartTurn({ prompt: "x", canvas: "16:9" }).ok).toBe(false);

    const intake = parseAgentIntake({
      version: 1,
      prompt: "Reel from the interview",
      intent: "edit",
      format: "auto",
      files: [],
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(intake.ok && intake.value.format).toBe("auto");
    // An intake file written by the removed Plan mode still loads, as an Edit turn.
    const legacy = parseAgentIntake({ version: 1, prompt: "x", intent: "plan", files: [] });
    expect(legacy.ok && legacy.value.intent).toBe("edit");
    const plain = parseAgentIntake({ version: 1, prompt: "x", files: [] });
    expect(plain.ok && "format" in plain.value).toBe(false);
    expect(parseAgentIntake({ version: 1, prompt: "x", files: [], format: "9:16" }).ok).toBe(false);
  });

  it("validates revert modes", () => {
    expect(parseRevertTurn(undefined)).toEqual({ ok: true, value: {} });
    expect(parseRevertTurn({ mode: "just-this" })).toEqual({
      ok: true,
      value: { mode: "just-this" },
    });
    expect(parseRevertTurn({ mode: "back-to-before" }).ok).toBe(false);
  });

  it("validates a Story Mode offer answer", () => {
    expect(parseAnswerStoryOffer({ decision: "accept" })).toEqual({
      ok: true,
      value: { decision: "accept" },
    });
    expect(parseAnswerStoryOffer({ decision: "decline" })).toEqual({
      ok: true,
      value: { decision: "decline" },
    });
    expect(parseAnswerStoryOffer({ decision: "yes" }).ok).toBe(false);
    expect(parseAnswerStoryOffer({}).ok).toBe(false);
    expect(parseAnswerStoryOffer(undefined).ok).toBe(false);
  });

  it("parses a turn's mode and Story workspace action, and refuses unknown ones", () => {
    expect(parseStartTurn({ prompt: "x" })).toEqual({ ok: true, value: { prompt: "x" } });
    expect(
      parseStartTurn({ prompt: "Build the story", mode: "story", storyAction: "build" }),
    ).toEqual({
      ok: true,
      value: { prompt: "Build the story", mode: "story", storyAction: "build" },
    });
    expect(parseStartTurn({ prompt: "x", mode: "cinema" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", storyAction: "publish" }).ok).toBe(false);
  });

  it("accepts the user's rebuild/build options only with those actions, and only what each action uses", () => {
    expect(
      parseStartTurn({
        prompt: "Rebuild",
        storyAction: "rebuild",
        storyOptions: { chapters: ["ch1", "ch1"], manualEdits: "replace", allowLocked: ["ch2"] },
      }),
    ).toEqual({
      ok: true,
      value: {
        prompt: "Rebuild",
        storyAction: "rebuild",
        storyOptions: { chapters: ["ch1"], manualEdits: "replace", allowLocked: ["ch2"] },
      },
    });
    const refused = [
      { storyAction: "review", storyOptions: { allowLocked: ["ch2"] } },
      { storyOptions: { manualEdits: "keep" } },
      { storyAction: "build", storyOptions: { manualEdits: "replace" } },
      { storyAction: "build", storyOptions: { chapters: ["ch1"] } },
      { storyAction: "rebuild", storyOptions: { manualEdits: "merge" } },
      { storyAction: "rebuild", storyOptions: { allowLocked: ["../x"] } },
      { storyAction: "rebuild", storyOptions: { force: true } },
    ];
    for (const body of refused) expect(parseStartTurn({ prompt: "x", ...body }).ok).toBe(false);
    expect(
      parseStartTurn({ prompt: "x", storyAction: "build", storyOptions: { allowLocked: ["ch2"] } })
        .ok,
    ).toBe(true);
  });

  it("parses a chat's active mode and refuses unknown ones", () => {
    expect(parseUpdateChat({ activeMode: "story" })).toEqual({
      ok: true,
      value: { activeMode: "story" },
    });
    expect(parseUpdateChat({ activeMode: "normal" }).ok).toBe(true);
    expect(parseUpdateChat({ activeMode: "cinema" }).ok).toBe(false);
  });

  it("carries the Story workspace state of the editor context and ignores anything malformed", () => {
    const parsedWith = (storyGraph: unknown) => {
      const parsed = parseStartTurn({ prompt: "x", editorContext: { ...context, storyGraph } });
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.value.editorContext?.storyGraph;
    };
    expect(parsedWith({ version: "sha256:ab", selectedNode: "ch2" })).toEqual({
      version: "sha256:ab",
      selectedNode: "ch2",
    });
    expect(parsedWith({ version: null })).toEqual({ version: null, selectedNode: null });
    expect(parsedWith(null)).toBeNull();
    expect(parsedWith("ch2")).toBeNull();
  });
});

describe("SSE codec", () => {
  it("round-trips multi-line data across arbitrary chunk boundaries", () => {
    const wire =
      encodeSseMessage({ id: "3", event: "chat", data: "a\nb" }) +
      ": keepalive\n\n" +
      encodeSseMessage({ data: "{}" });
    const parser = new SseParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 3) out.push(...parser.push(wire.slice(i, i + 3)));
    expect(out).toEqual([{ id: "3", event: "chat", data: "a\nb" }, { data: "{}" }]);
  });
});

describe("multi-agent events", () => {
  const run: AgentRun = {
    id: "r1",
    turnId: "t1",
    agent: "editor",
    parentRunId: null,
    title: "Trim intro",
    status: "running",
    model: null,
    thinking: null,
    routedByDirector: false,
    taskMessageId: "k1",
    assistantMessageId: "e1",
    startedAt: 4,
    summary: null,
  };

  function multiAgentLog(end: ChatEvent["type"]): ChatEvent[] {
    const base = log().slice(0, 2);
    const events: Omit<ChatEvent, "seq" | "chatId" | "ts">[] = [
      {
        type: "plan.updated",
        turnId: "t1",
        plan: {
          steps: [{ id: "s1", title: "Trim intro", status: "running", agent: "editor" }],
          updatedAt: 3,
        },
      },
      {
        type: "agent.started",
        run,
        parentMessageId: "m2",
        taskMessage: {
          id: "k1",
          chatId: "c1",
          turnId: "t1",
          createdAt: 4,
          role: "task",
          runId: "r1",
          agent: "editor",
          from: "director",
          parts: [{ type: "text", id: "kt", text: "Trim the intro" }],
          steering: false,
        },
        assistantMessage: { ...assistant, id: "e1", runId: "r1", agent: "editor", createdAt: 4 },
      },
      { type: "assistant.text.delta", messageId: "e1", partId: "et", delta: "Trimmed." },
      ...(end === "agent.completed"
        ? [
            {
              type: "agent.completed" as const,
              run: { ...run, status: "completed" as const, endedAt: 6, summary: "Trimmed." },
            },
            {
              type: "turn.completed" as const,
              turn: { ...turn, status: "completed" as const, endedAt: 9 },
            },
          ]
        : [
            {
              type: "turn.aborted" as const,
              turn: { ...turn, status: "interrupted" as const, endedAt: 9 },
            },
          ]),
    ];
    return [
      ...base,
      ...events.map((event, index) => ({
        ...event,
        seq: base.length + index + 1,
        chatId: "c1",
        ts: 20 + index,
      })),
    ];
  }

  it("opens a run thread, marks the delegation point and keeps the plan when the turn ends", () => {
    const state = foldChatEvents(multiAgentLog("agent.completed"));
    const director = state?.messages.find((message) => message.id === "m2");
    expect(director?.role === "assistant" ? director.parts : []).toEqual([
      { type: "delegation", id: "r1", runId: "r1" },
    ]);
    expect(state?.messages.filter((message) => message.runId === "r1").map((m) => m.role)).toEqual([
      "task",
      "assistant",
    ]);
    expect(state?.messages.find((message) => message.id === "e1")).toMatchObject({
      status: "complete",
    });
    expect(state?.runs).toMatchObject([{ id: "r1", status: "completed", summary: "Trimmed." }]);
    // turn.completed does not repeat the plan; the folded turn keeps it
    expect(state?.turns[0]?.plan?.steps[0]?.title).toBe("Trim intro");
  });

  it("a turn that ends with runs still open settles them (no orphan runs)", () => {
    const state = foldChatEvents(multiAgentLog("turn.aborted"));
    expect(state?.runs[0]?.status).toBe("interrupted");
    expect(state?.turns[0]?.plan?.steps.map((step) => step.status)).toEqual(["skipped"]);
    expect(state?.messages.find((message) => message.id === "e1")).toMatchObject({
      status: "aborted",
    });
  });

  it("keeps a plan proposal's pending steps when its turn ends (the user has not decided yet)", () => {
    const events = [
      ...log().slice(0, 2),
      {
        type: "plan.updated" as const,
        turnId: "t1",
        plan: {
          steps: [
            {
              id: "s1",
              title: "Build the intro",
              status: "pending" as const,
              agent: "motion" as const,
            },
          ],
          updatedAt: 3,
          proposal: true,
        },
      },
      {
        type: "turn.completed" as const,
        turn: { ...turn, status: "completed" as const, endedAt: 9 },
      },
    ].map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index }));
    const state = foldChatEvents(events);
    expect(state?.turns[0]?.plan).toMatchObject({ proposal: true });
    expect(state?.turns[0]?.plan?.steps.map((step) => step.status)).toEqual(["pending"]);
    expect(state?.turns[0]?.plan?.steps[0]?.title).toBe("Build the intro");
  });
});

describe("agent configuration validators", () => {
  it("accepts known specialists in canonical order and rejects unknown ones", () => {
    expect(parseUpdateChat({ enabledAgents: ["vision", "editor"] })).toEqual({
      ok: true,
      value: { enabledAgents: ["editor", "vision"] },
    });
    expect(parseUpdateChat({ enabledAgents: ["editor", "jev"] }).ok).toBe(false);
    expect([null, undefined, {}].map((body) => parseUpdateChat(body).ok)).toEqual([
      false,
      false,
      false,
    ]);
    expect(parseUpdateChat({ agentOverrides: { director: null } }).ok).toBe(false);
    expect(
      parseUpdateChat({
        agentOverrides: {
          vision: { model: { provider: "p", modelId: "m" }, thinking: "low", allowedModels: [] },
          audio: null,
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        agentOverrides: {
          vision: { model: { provider: "p", modelId: "m" }, thinking: "low", allowedModels: [] },
          audio: null,
        },
      },
    });
  });

  it("validates global settings and the Jev key", () => {
    expect(
      parseUpdateAgentSettings({
        jev: { enabled: true, credentials: "api-key", provider: "openrouter" },
      }),
    ).toEqual({
      ok: true,
      value: { jev: { enabled: true, credentials: "api-key", provider: "openrouter" } },
    });
    expect(parseUpdateAgentSettings({ jev: { credentials: "oauth" } }).ok).toBe(false);
    expect(
      parseUpdateAgentSettings({ specialists: { editor: { model: null, thinking: null } } }).ok,
    ).toBe(false);
    expect(parseSetJevApiKey({ apiKey: "sk-123" })).toEqual({
      ok: true,
      value: { apiKey: "sk-123" },
    });
    expect(parseSetJevApiKey({ apiKey: "sk 123" }).ok).toBe(false);
    expect(parseSetJevApiKey({ apiKey: null })).toEqual({ ok: true, value: { apiKey: null } });
  });

  it("accepts thinking off for the Director, specialists and Jev", () => {
    expect(
      parseUpdateAgentSettings({
        director: { model: null, thinking: "off" },
        specialists: {
          vision: { model: null, thinking: "off", allowedModels: [], enabledByDefault: false },
        },
        jev: { thinking: "off" },
      }),
    ).toEqual({
      ok: true,
      value: {
        director: { model: null, thinking: "off" },
        specialists: {
          vision: { model: null, thinking: "off", allowedModels: [], enabledByDefault: false },
        },
        jev: { thinking: "off" },
      },
    });
  });

  it("validates the autonomy settings group", () => {
    expect(DEFAULT_AUTONOMY_SETTINGS).toEqual({
      planApproval: "big",
      askBeforeLockedEdits: true,
      askBeforeDownloads: true,
    });
    expect(
      parseUpdateAgentSettings({
        autonomy: { planApproval: "always", askBeforeDownloads: false },
      }),
    ).toEqual({
      ok: true,
      value: { autonomy: { planApproval: "always", askBeforeDownloads: false } },
    });
    expect(parseUpdateAgentSettings({ autonomy: {} })).toEqual({
      ok: true,
      value: { autonomy: {} },
    });
    // An old settings file still carrying the removed defaultIntent loads: the field is ignored.
    expect(
      parseUpdateAgentSettings({
        autonomy: { defaultIntent: "plan", askBeforeLockedEdits: false },
      }),
    ).toEqual({ ok: true, value: { autonomy: { askBeforeLockedEdits: false } } });
    expect(parseUpdateAgentSettings({ autonomy: { planApproval: "sometimes" } }).ok).toBe(false);
    expect(parseUpdateAgentSettings({ autonomy: { askBeforeLockedEdits: "yes" } }).ok).toBe(false);
    expect(parseUpdateAgentSettings({ autonomy: { askBeforeDownloads: 1 } }).ok).toBe(false);
    expect(parseUpdateAgentSettings({ autonomy: [] }).ok).toBe(false);
  });

  it("keeps the Mode chip to Edit and Ask, and reads the removed Plan intent from stored data", () => {
    expect(normalizeChatIntent("plan")).toBe("edit");
    expect(normalizeChatIntent("ask")).toBe("ask");
    expect(normalizeChatIntent("edit")).toBe("edit");
    expect(normalizeChatIntent("cinema")).toBeNull();
    expect(parseUpdateChat({ intent: "ask" })).toEqual({ ok: true, value: { intent: "ask" } });
    expect(parseUpdateChat({ intent: "plan" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", intent: "ask" }).ok).toBe(true);
    expect(parseStartTurn({ prompt: "x", intent: "plan" }).ok).toBe(false);
  });

  it("carries the approved plan of an execute turn and refuses malformed or conflicting ones", () => {
    expect(parseStartTurn({ prompt: "Carry out the plan", executePlan: { turnId: "t1" } })).toEqual(
      {
        ok: true,
        value: { prompt: "Carry out the plan", executePlan: { turnId: "t1" } },
      },
    );
    expect(parseStartTurn({ prompt: "x", intent: "edit", executePlan: { turnId: "t1" } }).ok).toBe(
      true,
    );
    expect(parseStartTurn({ prompt: "x", executePlan: {} }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", executePlan: { turnId: "  " } }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", executePlan: "t1" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", intent: "ask", executePlan: { turnId: "t1" } }).ok).toBe(
      false,
    );
    expect(
      parseStartTurn({
        prompt: "x",
        storyAction: "build",
        executePlan: { turnId: "t1" },
      }).ok,
    ).toBe(false);
  });

  it("validates a provider API key body and provider ids", () => {
    expect(parseSetProviderApiKey({ apiKey: " sk-ant-123 " })).toEqual({
      ok: true,
      value: { apiKey: "sk-ant-123" },
    });
    expect(parseSetProviderApiKey({ apiKey: null })).toEqual({ ok: true, value: { apiKey: null } });
    expect(parseSetProviderApiKey({ apiKey: "" }).ok).toBe(false);
    expect(parseSetProviderApiKey({ apiKey: "sk 123" }).ok).toBe(false);
    expect(parseSetProviderApiKey({ apiKey: 7 }).ok).toBe(false);
    expect(parseSetProviderApiKey({}).ok).toBe(false);
    expect(parseSetProviderApiKey(undefined).ok).toBe(false);
    expect(parseSetProviderApiKey({ apiKey: "x".repeat(LIMITS.apiKeyChars + 1) }).ok).toBe(false);
    const rejected = parseSetProviderApiKey({ apiKey: "secret value" });
    expect(rejected.ok ? "" : rejected.message).not.toContain("secret");

    for (const id of ["anthropic", "openai-codex", "llama.cpp", "zai", "a"])
      expect(isProviderId(id)).toBe(true);
    for (const id of ["", ".", "..", "__proto__", "a/b", "a b", "-x", "é", "x".repeat(65)])
      expect(isProviderId(id)).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });

  it("validates the in-app sign-in requests and the state a runtime answers with", () => {
    // A sign-in's credential source is its own value, next to OMP's and an API key.
    expect(PROVIDER_CREDENTIAL_SOURCES).toEqual(["omp", "api-key", "oauth"]);

    expect(parseStartOAuthLogin(undefined)).toEqual({ ok: true, value: {} });
    expect(parseStartOAuthLogin(null)).toEqual({ ok: true, value: {} });
    expect(parseStartOAuthLogin({})).toEqual({ ok: true, value: {} });
    expect(parseStartOAuthLogin({ flow: "device" })).toEqual({
      ok: true,
      value: { flow: "device" },
    });
    expect(parseStartOAuthLogin({ flow: "telepathy" }).ok).toBe(false);
    expect(parseStartOAuthLogin([]).ok).toBe(false);

    expect(
      parseSubmitOAuthLoginInput({ text: " http://localhost:54545/callback?code=abc " }),
    ).toEqual({
      ok: true,
      value: { text: "http://localhost:54545/callback?code=abc" },
    });
    expect(parseSubmitOAuthLoginInput({ text: "   " })).toEqual({ ok: true, value: { text: "" } });
    for (const body of [undefined, {}, { text: 5 }])
      expect(parseSubmitOAuthLoginInput(body).ok).toBe(false);
    const tooLong = parseSubmitOAuthLoginInput({ text: "x".repeat(LIMITS.oauthInputChars + 1) });
    expect(tooLong.ok).toBe(false);
    // A rejected answer is never quoted back.
    const rejected = parseSubmitOAuthLoginInput({ text: "a".repeat(LIMITS.oauthInputChars + 1) });
    expect(rejected.ok ? "" : rejected.message).not.toContain("aaaa");

    for (const id of ["0123456789abcdef0123456789abcdef", "abcdefgh", "A_b-c-d-e-f"])
      expect(isOAuthLoginId(id)).toBe(true);
    for (const id of ["", "short", "a/b/c/d/e/f", "../../x-x-x-x", "a b c d e f g", "x".repeat(65)])
      expect(isOAuthLoginId(id)).toBe(false);

    const state: OAuthLoginState = {
      id: "0123456789abcdef0123456789abcdef",
      provider: "anthropic",
      status: "pending",
      flow: "browser",
      authUrl: "https://claude.example/authorize",
      instructions: null,
      deviceCode: null,
      progress: null,
      prompt: { message: "Paste the code", placeholder: null, secret: true, optional: true },
      error: null,
      startedAt: 1,
      expiresAt: 2,
    };
    expect(isOAuthLoginState(state)).toBe(true);
    expect(isOAuthLoginState({ ...state, prompt: null })).toBe(true);
    expect(isOAuthLoginState({ ...state, status: "done" })).toBe(false);
    expect(isOAuthLoginState({ ...state, flow: "magic" })).toBe(false);
    expect(isOAuthLoginState({ ...state, id: "x" })).toBe(false);
    expect(isOAuthLoginState({ ...state, prompt: { message: "x" } })).toBe(false);
    expect(isOAuthLoginState(null)).toBe(false);
  });
});
