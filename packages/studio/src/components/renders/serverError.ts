import { isRecord, readErrorParams } from "@hyperframes/agent-protocol";
import { describeServerError } from "../../agent/agentErrors";
import { t } from "../../i18n";

/**
 * The render route answers a refusal with `{ error, hint }` (an `{ code, message, params }` error object or a plain
 * string) naming the exact cause and how to fix it. Studio used to print the bare status code and drop that body,
 * which is why the most common Studio export failure reached users as "Server error (503)" with no mention of the
 * missing FFmpeg the server had already diagnosed. The status code is the fallback now, not the message.
 */
export async function readServerError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body)) {
      const { error, hint } = body;
      let text: string | null = null;
      if (typeof error === "string" && error) {
        text = error;
      } else if (isRecord(error) && typeof error.message === "string" && error.message) {
        const code = typeof error.code === "string" ? error.code : "";
        text = describeServerError(code, error.message, readErrorParams(error.params));
      }
      if (text) return typeof hint === "string" && hint ? `${text}. ${hint}` : text;
    }
  } catch {
    // Not JSON, or the body was already consumed — fall through to the status.
  }
  return t("renders.error.server", { status: res.status });
}
