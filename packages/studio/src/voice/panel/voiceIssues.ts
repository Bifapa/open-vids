import type { VoiceScriptIssue, VoiceScriptIssueCode } from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../../i18n";

const ISSUE_KEYS = {
  empty_text: "voice.issue.empty_text",
  too_long: "voice.issue.too_long",
  foreign_tag_syntax: "voice.issue.foreign_tag_syntax",
  unknown_tag: "voice.issue.unknown_tag",
  tags_unsupported: "voice.issue.tags_unsupported",
  ssml_unsupported: "voice.issue.ssml_unsupported",
  style_unsupported: "voice.issue.style_unsupported",
  style_too_long: "voice.issue.style_too_long",
  digits: "voice.issue.digits",
  approximate_dialect: "voice.setup.approximate",
} as const satisfies Record<VoiceScriptIssueCode, TranslationKey>;

function isKnownCode(code: string): code is VoiceScriptIssueCode {
  return Object.hasOwn(ISSUE_KEYS, code);
}

/**
 * A dialect finding in Studio's words. The service's own English fills in for a code this Studio does not know yet
 * (a newer service), so a finding is never swallowed.
 */
export function describeVoiceIssue(issue: VoiceScriptIssue): string {
  return isKnownCode(issue.code) ? t(ISSUE_KEYS[issue.code], issue.params ?? {}) : issue.message;
}
