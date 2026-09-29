import {
  AGENT_DISPLAY_NAMES,
  type AssistantMessage,
  type AssistantPart,
  type MessageReference,
  type TaskMessage,
  type UserMessage,
} from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";
import { ActivityRow } from "./ActivityRow";
import { DelegationRow } from "./DelegationRow";
import { MarkdownLite } from "./MarkdownLite";
import { ThinkingBlock } from "./ThinkingBlock";

const seconds = (value: number) => `${Math.round(value * 10) / 10}s`;

/** What a reference chip says, or null for kinds with no display yet (media has no UI in this milestone). */
export function referenceChipLabel(reference: MessageReference): string | null {
  switch (reference.kind) {
    case "editor-selection":
      return reference.label ?? "Editor selection";
    case "timeline-range":
      return reference.label ?? `Timeline ${seconds(reference.start)}–${seconds(reference.end)}`;
    case "asset":
      return reference.label ?? reference.path;
    case "url":
      return reference.title ?? reference.label ?? reference.url;
    default:
      return null;
  }
}

function ReferenceChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 text-step-10 text-text-2">
      {label}
    </span>
  );
}

export function UserBubble({ message }: { message: UserMessage }) {
  const chips: { id: string; label: string }[] = [];
  const texts: { id: string; text: string }[] = [];
  for (const part of message.parts) {
    if (part.type === "text") texts.push({ id: part.id, text: part.text });
    else {
      const label = referenceChipLabel(part.reference);
      if (label) chips.push({ id: part.id, label });
    }
  }
  return (
    <div className="flex flex-col items-end gap-1" data-role="user">
      {message.steering && (
        <span className="text-step-10 uppercase tracking-wide text-accent">steering</span>
      )}
      <div className="max-w-[92%] rounded-lg rounded-br-sm bg-surface px-3 py-2 text-step-12 leading-relaxed text-text-0">
        {texts.map((part) => (
          <p key={part.id} className="whitespace-pre-wrap break-words">
            {part.text}
          </p>
        ))}
        {chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <ReferenceChip key={chip.id} label={chip.label} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The instruction a delegated agent works from: the Director's task, or a follow-up to it. */
export function TaskBubble({ message }: { message: TaskMessage }) {
  const from = AGENT_DISPLAY_NAMES[message.from];
  return (
    <div
      data-role="task"
      className="flex flex-col gap-1 rounded-md border border-l-2 border-hairline border-l-accent/60 bg-surface/40 px-3 py-2"
    >
      <span
        className={cn(
          "text-step-10 uppercase tracking-wide",
          message.steering ? "text-accent" : "text-text-3",
        )}
      >
        {message.steering ? `Follow-up from ${from}` : `Task from ${from}`}
      </span>
      {message.parts.map((part) => (
        <MarkdownLite key={part.id} text={part.text} />
      ))}
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      data-testid="streaming-caret"
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent motion-reduce:animate-none"
    />
  );
}

function PartView({ part, live, caret }: { part: AssistantPart; live: boolean; caret: boolean }) {
  switch (part.type) {
    case "text":
      return (
        <div>
          <MarkdownLite text={part.text} />
          {caret && <StreamingCaret />}
        </div>
      );
    case "thinking":
      return <ThinkingBlock part={part} live={live} />;
    case "activity":
      return <ActivityRow activity={part.activity} />;
    case "delegation":
      return <DelegationRow runId={part.runId} />;
  }
}

export function AssistantBlock({ message }: { message: AssistantMessage }) {
  const streaming = message.status === "streaming";
  const lastTextId = [...message.parts].reverse().find((part) => part.type === "text")?.id;
  const last = message.parts[message.parts.length - 1];
  // The caret trails the text only while the text is what is being written.
  const caretOnText = streaming && last?.type === "text";

  return (
    <div className="flex flex-col gap-2" data-role="assistant" data-status={message.status}>
      {message.parts.map((part) => (
        <PartView
          key={part.id}
          part={part}
          live={streaming}
          caret={caretOnText && part.id === lastTextId}
        />
      ))}
      {streaming && message.parts.length === 0 && (
        <span className="animate-pulse text-step-11 text-text-3 motion-reduce:animate-none">
          Working…
        </span>
      )}
    </div>
  );
}
