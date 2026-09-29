import type { Activity, AssistantMessageStatus, TurnSummary } from "@hyperframes/agent-protocol";
import type { BackendEvent } from "./backend.js";
import type { ChatService } from "./chats.js";

export type StreamTimerHandle = NodeJS.Timeout;

export interface StreamTimerApi {
  setTimeout(callback: () => void, delayMs: number): StreamTimerHandle;
  clearTimeout(timer: StreamTimerHandle): void;
}

interface StreamOptions {
  chats: ChatService;
  chatId: string;
  messageId: string;
  turn: TurnSummary;
  now: () => number;
  ids: () => string;
  timers: StreamTimerApi;
  onModel: (event: Extract<BackendEvent, { type: "model.resolved" }>) => void;
}

interface TextSegment {
  kind: "text" | "thinking";
  partId: string;
}

interface PendingDelta extends TextSegment {
  delta: string;
}

interface ActivityGroup {
  activity: Activity;
  pending: Set<string>;
  failed: boolean;
  closed: boolean;
}

/** Serializes normalized backend events into stable, product-level chat events. */
export class TurnEventWriter {
  private tail: Promise<void> = Promise.resolve();
  private segment: TextSegment | null = null;
  private pending: PendingDelta | null = null;
  private flushTimer: StreamTimerHandle | null = null;
  private currentGroup: ActivityGroup | null = null;
  private readonly activityGroups = new Map<string, ActivityGroup>();
  private readonly toolGroups = new Map<string, ActivityGroup>();

  constructor(private readonly options: StreamOptions) {}

  accept(event: BackendEvent): void {
    if (event.type === "text.delta" || event.type === "thinking.delta") {
      this.acceptDelta(event.type === "text.delta" ? "text" : "thinking", event.delta);
      return;
    }
    this.flushPending();
    if (event.type === "thinking.end") {
      this.finishThinkingSegment();
      this.closeCurrentActivity();
      return;
    }
    if (event.type === "tool.start" || event.type === "tool.end") {
      this.finishThinkingSegment();
      this.segment = null;
      if (event.type === "tool.start") this.startTool(event.toolCallId, event.kind, event.targets);
      else this.endTool(event.toolCallId, event.ok);
      return;
    }
    this.closeCurrentActivity();
    this.options.onModel(event);
  }

  async finish(status: AssistantMessageStatus): Promise<void> {
    this.flushPending();
    this.finishThinkingSegment();
    this.segment = null;
    for (const group of this.activityGroups.values()) {
      if (group.activity.status === "running") {
        group.pending.clear();
        this.finishActivity(group, status === "failed" || group.failed ? "failed" : "done");
      }
    }
    await this.tail;
  }

  private acceptDelta(kind: TextSegment["kind"], delta: string): void {
    this.closeCurrentActivity();
    if (this.segment?.kind !== kind) {
      this.flushPending();
      this.finishThinkingSegment();
      this.segment = { kind, partId: this.options.ids() };
    }
    const segment = this.segment;
    if (!segment) return;
    if (this.pending?.partId === segment.partId) this.pending.delta += delta;
    else {
      this.flushPending();
      this.pending = { ...segment, delta };
    }
    if (!this.flushTimer) {
      this.flushTimer = this.options.timers.setTimeout(() => this.flushPending(), 50);
    }
  }

  private flushPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (this.flushTimer) this.options.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (pending.kind === "text") {
      this.enqueue(() =>
        this.options.chats
          .emit(this.options.chatId, {
            type: "assistant.text.delta",
            messageId: this.options.messageId,
            partId: pending.partId,
            delta: pending.delta,
          })
          .then(() => undefined),
      );
    } else {
      this.enqueue(() =>
        this.options.chats
          .emit(this.options.chatId, {
            type: "thinking.updated",
            messageId: this.options.messageId,
            partId: pending.partId,
            delta: pending.delta,
            done: false,
          })
          .then(() => undefined),
      );
    }
  }

  private finishThinkingSegment(): void {
    const partId = this.segment?.kind === "thinking" ? this.segment.partId : null;
    this.segment = null;
    if (!partId) return;
    this.enqueue(() =>
      this.options.chats
        .emit(this.options.chatId, {
          type: "thinking.updated",
          messageId: this.options.messageId,
          partId,
          delta: "",
          done: true,
        })
        .then(() => undefined),
    );
  }
  private startTool(toolCallId: string, category: Activity["category"], targets: string[]): void {
    if (this.toolGroups.has(toolCallId)) return;
    if (this.currentGroup && this.currentGroup.activity.category !== category)
      this.closeCurrentActivity();
    if (!this.currentGroup) {
      const activity: Activity = {
        id: this.options.ids(),
        category,
        status: "running",
        label: activityLabel(category, 0, []),
        count: 0,
        targets: [],
        startedAt: this.options.now(),
      };
      this.currentGroup = { activity, pending: new Set(), failed: false, closed: false };
      this.activityGroups.set(activity.id, this.currentGroup);
    }
    const group = this.currentGroup;
    group.pending.add(toolCallId);
    const uniqueTargets = [...new Set([...group.activity.targets, ...targets])].slice(0, 5);
    group.activity = {
      ...group.activity,
      status: "running",
      count: group.activity.count + 1,
      targets: uniqueTargets,
      label: activityLabel(category, group.activity.count + 1, uniqueTargets),
      endedAt: undefined,
    };
    this.toolGroups.set(toolCallId, group);
    this.publishActivity(group.activity);
  }

  private endTool(toolCallId: string, ok: boolean): void {
    const group = this.toolGroups.get(toolCallId);
    if (!group) return;
    this.toolGroups.delete(toolCallId);
    group.pending.delete(toolCallId);
    group.failed ||= !ok;
    if (group.pending.size === 0 && group.closed) {
      this.finishActivity(group, group.failed ? "failed" : "done");
    }
  }

  private closeCurrentActivity(): void {
    const group = this.currentGroup;
    this.currentGroup = null;
    if (!group) return;
    group.closed = true;
    if (group.pending.size === 0 && group.activity.status === "running") {
      this.finishActivity(group, group.failed ? "failed" : "done");
    }
  }

  private finishActivity(group: ActivityGroup, status: "done" | "failed"): void {
    this.publishActivity({ ...group.activity, status, endedAt: this.options.now() });
  }

  private publishActivity(activity: Activity): void {
    const partId = activity.id;
    this.enqueue(() =>
      this.options.chats
        .emit(this.options.chatId, {
          type: "activity.updated",
          messageId: this.options.messageId,
          activity: { ...activity },
        })
        .then(() => undefined),
    );
    const group = this.activityGroups.get(partId);
    if (group) group.activity = { ...activity };
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.catch(() => undefined).then(task);
  }
}

function activityLabel(category: Activity["category"], count: number, targets: string[]): string {
  if (category === "search") return "Searching the project";
  if (category === "other") return "Working";
  const verb = category === "inspect" ? "Reading" : "Editing";
  if (count > 1) return `${verb} ${count} files`;
  if (targets[0]) return `${verb} ${targets[0]}`;
  return `${verb} files`;
}
