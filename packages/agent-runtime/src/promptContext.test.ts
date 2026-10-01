import { describe, expect, it } from "vitest";
import { renderPromptContext, renderUserLanguageBlock } from "./promptContext.js";

describe("user language block", () => {
  it("names the language in English and asks for replies in it", () => {
    const block = renderUserLanguageBlock("ru");
    expect(block).toContain("<user-language>ru</user-language>");
    expect(block).toContain("Reply to the user in Russian");
    expect(renderUserLanguageBlock("pt-BR")).toContain("Brazilian Portuguese");
  });

  it("adds nothing for English, an absent tag or an unknown one", () => {
    expect(renderUserLanguageBlock("en")).toBeNull();
    expect(renderUserLanguageBlock("en-GB")).toBeNull();
    expect(renderUserLanguageBlock(undefined)).toBeNull();
    expect(renderUserLanguageBlock("zz-ZZZZ")).toBeNull();
  });

  it("keeps the English prompt byte-identical and appends the block last otherwise", () => {
    const plain = renderPromptContext("Trim the intro", undefined, [], "en");
    expect(plain).toBe("Trim the intro");
    const russian = renderPromptContext("Trim the intro", undefined, [], "ru");
    expect(russian.startsWith("Trim the intro\n\n<user-language>ru</user-language>")).toBe(true);
  });
});
