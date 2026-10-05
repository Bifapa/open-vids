import { readFile } from "node:fs/promises";
import path from "node:path";
import { guardToolCallPaths } from "./path-guard.ts";

/**
 * The project's AGENTS.md / CLAUDE.md as the in-app agent sees it.
 *
 * Every new project gets the shared template (`packages/cli/src/templates/_shared`). Parts of it are
 * written for external coding agents that have a shell and skills (install a skill, run
 * `hyperframes check`, open a preview). The in-app agent has neither, so those parts are wrapped in
 * start/end markers in the template and removed here before the file becomes context. An end marker
 * that is missing drops everything after the start marker, so a damaged file never hands shell
 * instructions to an agent that cannot follow them.
 */
const EXTERNAL_AGENT_SECTION =
  /<!--\s*openvids:external-agents:start\s*-->[\s\S]*?(?:<!--\s*openvids:external-agents:end\s*-->\n*|$)/g;

export function stripExternalAgentSections(content: string): string {
  return content.replaceAll(EXTERNAL_AGENT_SECTION, "").replaceAll(/\n{3,}/g, "\n\n");
}

/**
 * The project's AGENTS.md or CLAUDE.md (the first that exists and passes the project guard), as the context files
 * the OMP session loads.
 */
export async function projectContextFiles(
  projectDir: string,
): Promise<Array<{ path: string; content: string }>> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(projectDir, name);
    // The guard splits a path argument on whitespace, so an absolute path of a project with a space in its
    // name would be judged in pieces: check the file by its name relative to the project instead.
    if (await guardToolCallPaths(projectDir, { path: name })) continue;
    try {
      const content = await readFile(filePath, "utf8");
      return [{ path: filePath, content: stripExternalAgentSections(content) }];
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
    }
  }
  return [];
}
