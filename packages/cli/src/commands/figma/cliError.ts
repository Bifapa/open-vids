import { failCommand } from "../../utils/commandResult.js";
/**
 * Shared CLI error boundary for `hyperframes figma` subcommands: typed
 * client errors (NO_TOKEN, BAD_TOKEN, …) and input errors (bad ref, bad
 * format) all carry actionable, user-facing messages — present them via
 * the CLI's standard errorBox, not a stack trace. Non-Error throws still
 * surface raw.
 */

import { errorBox } from "../../ui/format.js";

export async function withFigmaErrors(command: string, fn: () => Promise<void>): Promise<void> {
  void command;
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error) {
      const [title = "figma command failed", ...rest] = err.message.split("\n");
      errorBox(title, rest.length > 0 ? rest.join("\n") : undefined);
      failCommand(1, err);
    }
    throw err;
  }
}
