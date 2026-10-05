// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../../locales/en.json";
import ru from "../../../../locales/ru.json";
import { AGENT_ERROR_CODES } from "@hyperframes/agent-protocol";
import { activityText } from "../components/chat/ActivityRow";
import { i18n } from "../i18n";
import { describeAgentFailure } from "./agentErrors";

const RUNTIME_SOURCES = join(import.meta.dirname, "../../../agent-runtime/src");

function runtimeSourceFiles(): string[] {
  return readdirSync(RUNTIME_SOURCES, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !/\.(test|testHelpers)\.ts$/.test(file))
    .map((file) => join(RUNTIME_SOURCES, file));
}

/**
 * Every code the runtime can put on an activity row (`labelCode`) or a run title (`titleCode`): the string literals
 * that follow the property, so a ternary of two codes counts both. A code that is computed instead of written out
 * cannot be checked here, which is why the runtime writes them as literals.
 */
function runtimeActivityCodes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of runtimeSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:labelCode|titleCode)\??:\s*([^,}\n]+)/g)) {
      for (const literal of (match[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)) {
        const code = literal[1];
        if (code) found.set(code, file.slice(RUNTIME_SOURCES.length + 1));
      }
    }
  }
  return found;
}

describe("activity label codes", () => {
  const codes = runtimeActivityCodes();

  it("finds the codes the runtime really uses (the scan itself works)", () => {
    expect(codes.size).toBeGreaterThan(20);
    expect(codes.has("reading_files")).toBe(true);
    expect(codes.has("provider_retry")).toBe(true);
    expect(codes.has("render_qa_pass")).toBe(true);
  });

  it.each([...codes.entries()])("has an English and a Russian activity.%s text", (code, file) => {
    // The file is only for the failure message: it says where the code without a key is written.
    expect(Object.hasOwn(en, `activity.${code}`), `activity.${code} (${file}) missing in en`).toBe(
      true,
    );
    expect(Object.hasOwn(ru, `activity.${code}`), `activity.${code} (${file}) missing in ru`).toBe(
      true,
    );
  });

  it("renders the runtime's provider notices with their parameters in both languages", async () => {
    i18n.addResourceBundle("ru", "translation", ru);
    const retry = { attempt: 2, maxAttempts: 4, delaySeconds: 8 };
    await i18n.changeLanguage("en");
    expect(activityText("fallback", "provider_retry", retry)).toBe(
      "The model call failed — retrying in 8 seconds (attempt 2 of 4)",
    );
    await i18n.changeLanguage("ru");
    expect(activityText("fallback", "provider_retry", retry)).toBe(
      "Вызов модели не удался — повтор через 8 секунд (попытка 2 из 4)",
    );
    expect(activityText("fallback", "context_compaction")).toBe(
      "Сжатие переписки, чтобы освободить контекст",
    );
    await i18n.changeLanguage("en");
  });
});

describe("agent error codes", () => {
  it.each([...AGENT_ERROR_CODES])("has plain-language copy for %s", (code) => {
    const sentence = describeAgentFailure(code, "the raw server message");
    expect(sentence).not.toBe("the raw server message");
    expect(sentence.length).toBeGreaterThan(0);
  });

  it("has a Russian sentence for every code (nothing falls back to English)", async () => {
    i18n.addResourceBundle("ru", "translation", ru);
    const params = { seconds: 3 };
    await i18n.changeLanguage("en");
    const english = AGENT_ERROR_CODES.map((code) => describeAgentFailure(code, "raw", params));
    await i18n.changeLanguage("ru");
    AGENT_ERROR_CODES.forEach((code, index) => {
      expect(describeAgentFailure(code, "raw", params), code).not.toBe(english[index]);
    });
    await i18n.changeLanguage("en");
  });
});
