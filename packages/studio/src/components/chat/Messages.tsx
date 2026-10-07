import { Fragment, type ReactNode } from "react";
import {
  Clock,
  Cursor,
  File,
  FilmStrip,
  FolderOpen,
  Image,
  LinkSimple,
  Waveform,
  type Icon,
} from "@phosphor-icons/react";
import type {
  ActivityPart,
  AgentId,
  AssistantMessage,
  AssistantPart,
  DelegationPart,
  MessageReference,
  TaskMessage,
  TurnSummary,
  UserMessage,
} from "@hyperframes/agent-protocol";
import { formatNumber, t, useTranslation, type TranslationKey } from "../../i18n";
import { projectChipLabel } from "../../agent/projectMentionLabels";
import { isPermissionPart } from "../../agent/permissionGuards";
import { isQuestionPart } from "../../agent/questionGuards";
import { isStoryOfferPart } from "../../agent/storyOfferGuards";
import { isVoicePilotPart, isVoiceSetupPart } from "../../agent/voiceChatGuards";
import { cn } from "../ui/cn";
import { Badge } from "../ui/Status";
import { ActivityRow } from "./ActivityRow";
import { AgentMonogram, chatAgentName } from "./AgentMonogram";
import { chatMeasure, chatMeasureWide, noteBox, sectLabel } from "./chatStyles";
import { DelegationRow } from "./DelegationRow";
import { MarkdownLite } from "./MarkdownLite";
import { DesignTurnTag } from "./DesignTurnParts";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { StoryOfferCard } from "./StoryOfferCard";
import { VoicePilotCard } from "./VoicePilotCard";
import { VoiceSetupCard } from "./VoiceSetupCard";
import { formatClockTime } from "./relativeTime";
import { ThinkingBlock } from "./ThinkingBlock";

const seconds = (value: number) =>
  t("chat.duration.seconds", {
    seconds: formatNumber(Math.round(value * 10) / 10, { maximumFractionDigits: 1 }),
  });

/** The last segment of a path or URL: what a file chip names. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** What a reference chip says. */
export function referenceChipLabel(reference: MessageReference): string {
  switch (reference.kind) {
    case "editor-selection":
      return reference.label ?? t("chat.reference.editorSelection");
    case "timeline-range":
      return (
        reference.label ??
        t("chat.reference.timeline", {
          start: seconds(reference.start),
          end: seconds(reference.end),
        })
      );
    case "project":
      return projectChipLabel(reference.name, reference.parts);
    case "asset":
      return reference.label ?? baseName(reference.path);
    case "url":
      return reference.title ?? reference.label ?? reference.url;
    default: {
      const source = reference.source;
      if (reference.label) return reference.label;
      if (source.type === "project-path") return baseName(source.path);
      if (source.type === "url") return baseName(source.url);
      return t("chat.reference.upload");
    }
  }
}

const REFERENCE_ICONS: Record<MessageReference["kind"], Icon> = {
  "editor-selection": Cursor,
  "timeline-range": Clock,
  asset: File,
  project: FolderOpen,
  url: LinkSimple,
  image: Image,
  video: FilmStrip,
  audio: Waveform,
  file: File,
};

const REFERENCE_KIND_NAMES: Record<MessageReference["kind"], TranslationKey> = {
  "editor-selection": "chat.reference.kind.selection",
  "timeline-range": "chat.reference.kind.range",
  asset: "chat.reference.kind.asset",
  project: "chat.reference.kind.project",
  url: "chat.reference.kind.link",
  image: "chat.reference.kind.image",
  video: "chat.reference.kind.video",
  audio: "chat.reference.kind.audio",
  file: "chat.reference.kind.file",
};

/** A read-only context chip on a sent message: kind icon + label, detail in the tooltip. */
function ReferenceChip({ reference }: { reference: MessageReference }) {
  const { t } = useTranslation();
  const KindIcon = REFERENCE_ICONS[reference.kind];
  const label = referenceChipLabel(reference);
  const kind = t(REFERENCE_KIND_NAMES[reference.kind]);
  return (
    <span
      role="listitem"
      title={t("chat.reference.chipTitle", { label, kind })}
      className="inline-flex h-ctl-sm max-w-full min-w-0 items-center gap-[5px] rounded-sm border border-border bg-bg-1 pr-2 pl-1.5 text-xs leading-none font-medium text-fg-2"
    >
      <KindIcon aria-hidden className="size-icon-sm shrink-0 text-fg-3" />
      <span
        className={cn(
          "min-w-0 truncate",
          reference.kind === "project" ? "max-w-[36ch]" : "max-w-[22ch]",
        )}
      >
        {label}
      </span>
      <span className="sr-only"> {t("chat.reference.kindSr", { kind })}</span>
    </span>
  );
}

/** Author, optional tags and time: the head every message shares. */
function MessageHead({
  agent,
  author,
  at,
  children,
}: {
  agent?: AgentId;
  author: string;
  at: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
      {agent && <AgentMonogram agent={agent} />}
      <span className="truncate font-semibold text-fg-2">{author}</span>
      {children}
      <time
        dateTime={new Date(at).toISOString()}
        className="ml-auto shrink-0 font-mono text-num leading-[14px] text-fg-3 tabular-nums"
      >
        {formatClockTime(at)}
      </time>
    </div>
  );
}

const INTENT_TAGS = { ask: "chat.intent.ask" } as const;

/** The user's message: set apart by a quiet surface fill; context chips above the text. */
export function UserMessageView({
  message,
  turn,
}: {
  message: UserMessage;
  /** The turn this message opened (absent for steering): tags how it ran. */
  turn?: TurnSummary;
}) {
  const { t } = useTranslation();
  const references: { id: string; reference: MessageReference }[] = [];
  const texts: { id: string; text: string }[] = [];
  for (const part of message.parts) {
    if (part.type === "text") texts.push({ id: part.id, text: part.text });
    else references.push({ id: part.id, reference: part.reference });
  }
  // Older turns may still store the removed `plan` intent: no badge then (it is not shown for Edit either).
  const asked = turn?.intent === "ask";
  return (
    <article
      data-role="user"
      className={cn("grid min-w-0 gap-1 rounded-md bg-surface-1 px-2 pt-1.5 pb-[7px]", chatMeasure)}
    >
      <MessageHead author={t("chat.message.you")} at={message.createdAt}>
        {message.steering && (
          <Badge size="sm" data-testid="steering-tag">
            {t("chat.message.steering")}
          </Badge>
        )}
        {turn?.mode === "story" && <Badge size="sm">{t("chat.message.storyTag")}</Badge>}
        <DesignTurnTag turn={turn} />
        {asked && <Badge size="sm">{t(INTENT_TAGS.ask)}</Badge>}
      </MessageHead>
      {references.length > 0 && (
        <div
          role="list"
          aria-label={t("chat.message.attached")}
          className="flex min-w-0 flex-wrap gap-1"
        >
          {references.map(({ id, reference }) => (
            <ReferenceChip key={id} reference={reference} />
          ))}
        </div>
      )}
      {texts.map((part) => (
        <p
          key={part.id}
          className="text-base leading-[18px] whitespace-pre-wrap text-fg [overflow-wrap:anywhere] text-pretty"
        >
          {part.text}
        </p>
      ))}
    </article>
  );
}

/** The instruction a delegated agent works from ("Task from Main"), or a follow-up to it. */
export function TaskBrief({ message, meta }: { message: TaskMessage; meta?: ReactNode }) {
  const { t } = useTranslation();
  const from = chatAgentName(message.from);
  return (
    <div data-role="task" className={cn(noteBox, "gap-[3px] px-[9px] pt-[7px] pb-2", chatMeasure)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs font-medium text-fg-3">
        <span>
          {message.steering
            ? t("chat.message.followUpFrom", { name: from })
            : t("chat.message.taskFrom", { name: from })}
        </span>
        {meta}
      </div>
      {message.parts.map((part) => (
        <MarkdownLite key={part.id} text={part.text} className="text-sm leading-[17px] text-fg-2" />
      ))}
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      data-testid="streaming-caret"
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-fg-2 motion-reduce:animate-none"
    />
  );
}

type WorkPart = ActivityPart | DelegationPart;
type Segment = { kind: "part"; part: AssistantPart } | { kind: "work"; parts: WorkPart[] };

/** Consecutive activity and delegation parts read as one Working list. */
function segments(parts: readonly AssistantPart[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (part.type === "activity" || part.type === "delegation") {
      if (last?.kind === "work") last.parts.push(part);
      else out.push({ kind: "work", parts: [part] });
    } else {
      out.push({ kind: "part", part });
    }
  }
  return out;
}

function WorkList({
  parts,
  agent,
  label,
}: {
  parts: WorkPart[];
  agent: AgentId;
  label: string | null;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={label ?? t("chat.work.activity")}
      className={cn("mt-1.5 grid min-w-0 gap-0.5", chatMeasureWide)}
    >
      {label && <div className={cn(sectLabel, "h-ctl-xs items-center")}>{label}</div>}
      <ul className="-mx-1.5 grid gap-px">
        {parts.map((part) =>
          part.type === "activity" ? (
            <ActivityRow key={part.id} activity={part.activity} agent={agent} />
          ) : (
            <DelegationRow key={part.id} runId={part.runId} />
          ),
        )}
      </ul>
    </section>
  );
}

function TextView({ text, interim, caret }: { text: string; interim: boolean; caret: boolean }) {
  const { t } = useTranslation();
  if (interim) {
    return (
      <div data-testid="interim-note" className={cn("grid gap-0.5", chatMeasure)}>
        <span className="text-xs font-medium text-fg-3">{t("chat.message.beforeQa")}</span>
        <MarkdownLite text={text} className="text-fg-2" />
        {caret && <StreamingCaret />}
      </div>
    );
  }
  return (
    <div className={chatMeasure}>
      <MarkdownLite text={text} />
      {caret && <StreamingCaret />}
    </div>
  );
}

/**
 * An agent's reply: head (monogram, name, time), then its parts in order — text, thinking, and Working lists
 * of its activities and delegations. `plan` sits just above the first Working list.
 */
export function AssistantBlock({
  message,
  plan,
  workLabel,
}: {
  message: AssistantMessage;
  plan?: ReactNode;
  /** Heading of the first Working list (default: "Working" while it streams, "Activity" after). */
  workLabel?: string;
}) {
  const { t } = useTranslation();
  const streaming = message.status === "streaming";
  const agent: AgentId = message.agent ?? "director";
  const lastTextId = [...message.parts].reverse().find((part) => part.type === "text")?.id;
  const last = message.parts[message.parts.length - 1];
  // The caret trails the text only while the text is what is being written.
  const caretOnText = streaming && last?.type === "text";
  const groups = segments(message.parts);
  const firstWork = groups.findIndex((group) => group.kind === "work");

  return (
    <article
      className="grid min-w-0 gap-1"
      data-role="assistant"
      data-status={message.status}
      aria-label={t("chat.message.reply", { name: chatAgentName(agent) })}
    >
      <MessageHead agent={agent} author={chatAgentName(agent)} at={message.createdAt} />
      {groups.map((group, index) => (
        <Fragment key={group.kind === "work" ? group.parts[0]?.id : group.part.id}>
          {index === firstWork && plan && <div className="mt-1.5">{plan}</div>}
          {group.kind === "work" ? (
            <WorkList
              parts={group.parts}
              agent={agent}
              label={
                index === firstWork
                  ? (workLabel ?? t(streaming ? "chat.work.working" : "chat.work.activity"))
                  : null
              }
            />
          ) : group.part.type === "text" ? (
            <TextView
              text={group.part.text}
              interim={group.part.interim === true}
              caret={caretOnText && group.part.id === lastTextId}
            />
          ) : group.part.type === "thinking" ? (
            <ThinkingBlock part={group.part} live={streaming} />
          ) : isPermissionPart(group.part) ? (
            <PermissionCard turnId={message.turnId} permission={group.part.permission} />
          ) : isQuestionPart(group.part) ? (
            <QuestionCard turnId={message.turnId} question={group.part.question} />
          ) : isStoryOfferPart(group.part) ? (
            <StoryOfferCard turnId={message.turnId} offer={group.part.offer} />
          ) : isVoiceSetupPart(group.part) ? (
            <VoiceSetupCard turnId={message.turnId} setup={group.part.setup} />
          ) : isVoicePilotPart(group.part) ? (
            <VoicePilotCard turnId={message.turnId} pilot={group.part.pilot} />
          ) : null}
        </Fragment>
      ))}
      {firstWork === -1 && plan && <div className="mt-1.5">{plan}</div>}
      {streaming && message.parts.length === 0 && (
        <span className="animate-pulse text-xs text-fg-3 motion-reduce:animate-none">
          {t("chat.work.workingEllipsis")}
        </span>
      )}
    </article>
  );
}
