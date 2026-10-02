/**
 * The OMP-backed project title: one short, tool-less completion with the composer's chosen model (or the runtime's
 * Main default). Nothing here opens a session or touches a project — `completeSimple` is the same primitive OMP uses
 * for its own session titles.
 */

import { completeSimple, type Api, type AssistantMessage, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { ProjectTitleRequest } from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "../errors.ts";
import { extractProjectTitle, projectTitleInstruction, projectTitleUserMessage } from "../title.ts";

/** The whole call may take this long; the caller falls back to its own derivation after that. */
const TITLE_TIMEOUT_MS = 8_000;

/** A title is a handful of tokens; the ceiling only has to survive backends that ignore `disableReasoning`. */
const TITLE_MAX_TOKENS = 256;

/** Greedy decoding: naming is extraction, not generation. Providers that reject sampling params drop it. */
const TITLE_TEMPERATURE = 0;

export interface ProjectTitleCall {
  model: Model<Api>;
  registry: ModelRegistry;
  request: ProjectTitleRequest;
}

function textOf(content: AssistantMessage["content"]): string {
  let text = "";
  for (const block of content) if (block.type === "text") text += block.text;
  return text;
}

/** One completion, then the title out of its answer; throws a `RuntimeError` the route passes on. */
export async function generateProjectTitleWithOmp(call: ProjectTitleCall): Promise<string> {
  const { model, registry, request } = call;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: [projectTitleInstruction(request.language)],
        messages: [
          {
            role: "user",
            content: projectTitleUserMessage(request.prompt, request.files),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: registry.resolver(model),
        maxTokens: TITLE_MAX_TOKENS,
        disableReasoning: true,
        temperature: TITLE_TEMPERATURE,
        signal: controller.signal,
      },
    );
    if (response.stopReason === "aborted")
      throw new RuntimeError("agent_failed", "Naming the project timed out.", 503);
    if (response.stopReason === "error")
      throw new RuntimeError(
        "agent_failed",
        response.errorMessage ?? "The model could not name the project.",
        502,
      );
    const title = extractProjectTitle(textOf(response.content));
    if (!title)
      throw new RuntimeError("agent_failed", "The model returned no usable project name.", 502);
    return title;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (controller.signal.aborted)
      throw new RuntimeError("agent_failed", "Naming the project timed out.", 503);
    throw new RuntimeError("agent_failed", errorMessage(error, "Naming the project failed."), 502);
  } finally {
    clearTimeout(timer);
  }
}
