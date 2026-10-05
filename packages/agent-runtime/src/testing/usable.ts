import type { ScriptedSession } from "./backend.js";

/** The names of the host tools a session was opened with. */
export const toolNames = (session: ScriptedSession | undefined): string[] =>
  session?.input.hostTools.map((tool) => tool.name) ?? [];

/** What dispatch answers for a tool that this kind of turn or this agent does not have. */
const UNAVAILABLE =
  /is not available to you in this turn|is not available in this turn|Story Mode turn: the timeline is not changed/;

/**
 * The tools of `names` an agent can use now. A session keeps one stable tool list across turns, so a tool being
 * offered says nothing about the turn: this calls each offered tool with empty arguments and drops the ones dispatch
 * refuses as unavailable (a tool that fails its argument check was available). Call it from inside a prompt script.
 */
export async function usableTools(session: ScriptedSession, names: string[]): Promise<string[]> {
  const offered = toolNames(session);
  const open: string[] = [];
  for (const name of names) {
    if (!offered.includes(name)) continue;
    const answer = await session.callTool(name, {});
    if (!(answer.isError && UNAVAILABLE.test(answer.text))) open.push(name);
  }
  return open;
}
