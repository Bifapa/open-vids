import {
  EXECUTION_BUDGETS,
  type AgentId,
  type ExecutionBudget,
  type ExecutionQuality,
  type SpecialistId,
  type TurnQaState,
} from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";

/** Test-only helpers shared by the render-QA test files. */

export type Script = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

export async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

export function script(fixture: RuntimeFixture, byAgent: Partial<Record<AgentId, Script>>): void {
  fixture.backend.promptScript = (input, session) =>
    (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
}

/** A custom Execution Quality: the Balanced budget with `qaPasses` and any overrides. */
export function quality(
  qaPasses: number,
  overrides: Partial<ExecutionBudget> = {},
): ExecutionQuality {
  return {
    preset: "custom",
    custom: { ...EXECUTION_BUDGETS.balanced, qaPasses, ...overrides },
  };
}

/** A chat whose Execution Quality is `executionQuality` and whose team is `enabled`. */
export async function qaChat(
  fixture: RuntimeFixture,
  executionQuality: ExecutionQuality,
  enabled: SpecialistId[] = ["editor", "vision"],
): Promise<string> {
  const chat = await fixture.chats.create({}, enabled);
  await fixture.chats.update(chat.id, { executionQuality });
  return chat.id;
}

export interface SeenPrompts {
  first: string;
  corrections: string[];
  finals: string[];
  /** `<render-qa-review>` prompts: the Director standing in for a disabled Vision. */
  reviews: string[];
  /** `<render-qa-skipped>` prompts: the closing answer when no check ran. */
  closings: string[];
}

export interface DirectorHooks {
  /** The Director's first prompt; the default changes the project (a new fingerprint). */
  first?: (session: ScriptedSession) => Promise<void>;
  /** A correction prompt (1-based); the default changes the project again. */
  correction?: (number: number, session: ScriptedSession, text: string) => Promise<void>;
  final?: (session: ScriptedSession, text: string) => Promise<void>;
  /** A review prompt (1-based); the default looks at two frames and reports no finding. */
  review?: (number: number, session: ScriptedSession, text: string) => Promise<void>;
}

/** A Director that does its work (changes the project), corrects when asked and reports, recording each prompt. */
export function directorScript(
  fixture: RuntimeFixture,
  hooks: DirectorHooks = {},
): { seen: SeenPrompts; run: Script } {
  const seen: SeenPrompts = { first: "", corrections: [], finals: [], reviews: [], closings: [] };
  const change = () => {
    fixture.qa.bump();
  };
  const run: Script = async (input, session) => {
    if (input.text.includes("<render-qa-final")) {
      seen.finals.push(input.text);
      await hooks.final?.(session, input.text);
    } else if (input.text.includes("<render-qa-review")) {
      seen.reviews.push(input.text);
      if (hooks.review) await hooks.review(seen.reviews.length, session, input.text);
      else {
        await session.callTool("inspect_render", { times: [1, 5] });
        await session.callTool("report_render_findings", { findings: [] });
      }
    } else if (input.text.includes("<render-qa-skipped")) {
      seen.closings.push(input.text);
    } else if (input.text.includes("<render-qa pass=")) {
      seen.corrections.push(input.text);
      if (hooks.correction) await hooks.correction(seen.corrections.length, session, input.text);
      else change();
    } else if (!seen.first) {
      seen.first = input.text;
      if (hooks.first) await hooks.first(session);
      else change();
    }
    return "completed";
  };
  return { seen, run };
}

export interface FindingInput {
  kind: string;
  severity: string;
  start: number;
  end: number;
  message: string;
  fixable: boolean;
  owner?: string | null;
  subject?: string | null;
  clipIds?: string[];
  suggestion?: string;
}

export function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    kind: "incorrect_broll",
    severity: "warning",
    start: 5,
    end: 7,
    message: "The B-roll shows a beach, the speaker talks about a city.",
    fixable: true,
    owner: "editor",
    subject: "c2",
    clipIds: ["c2"],
    suggestion: "Swap it for the city shot.",
    ...overrides,
  };
}

/** A Vision that looks at two frames and reports `findings` (null: finishes without reporting). */
export function visionScript(findings: FindingInput[] | null): Script {
  return async (_input, session) => {
    await session.callTool("inspect_render", { times: [1, 5] });
    if (findings !== null) await session.callTool("report_render_findings", { findings });
    return "completed";
  };
}

/**
 * Whether a Director prompt is Render QA's closing prompt (`<render-qa-skipped>`): the turn attempted work, nothing
 * changed, and the Director is asked once more for its final answer. A fixture script that makes tool calls on every
 * prompt skips them here, so the closing prompt does not re-run them.
 */
export function isQaClosing(input: BackendPromptInput): boolean {
  return input.text.includes("<render-qa-skipped");
}

export function untilAborted(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

/** `status|pass:phase,…` for every `qa.updated` event of the chat, consecutive duplicates removed. */
export function qaTimeline(fixture: RuntimeFixture, chatId: string): string[] {
  const rows: string[] = [];
  for (const event of fixture.chats.events(chatId)) {
    if (event.type !== "qa.updated") continue;
    const row = describeQa(event.qa);
    if (rows.at(-1) !== row) rows.push(row);
  }
  return rows;
}

export function describeQa(qa: TurnQaState): string {
  return `${qa.status}|${qa.passes.map((pass) => `${pass.pass}:${pass.phase}`).join(",")}`;
}
