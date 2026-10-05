import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sampleWebsiteStyle } from "../testing/research.js";
import { RESOURCE_TTL_MS, WebsiteResourceLog } from "./websiteResources.js";

const LOTTIE = "https://cdn.example-cdn.com/lottie/loader.json";

describe("WebsiteResourceLog persistence", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openvids-website-resources-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fileOf = async (chatId: string) => join(root, chatId, "website-resources.json");
  const read = { site: sampleWebsiteStyle("https://example.com/"), screenshots: [] };

  it("remembers what a read listed after the runtime restarts, per chat", async () => {
    const first = new WebsiteResourceLog({ fileOf });
    await first.rememberRead("chat-1", read);
    expect(await first.has("chat-1", LOTTIE)).toBe(true);

    // A new process: a log with the same directory sees the file, and a chat that never read does not.
    const restarted = new WebsiteResourceLog({ fileOf });
    expect(await restarted.has("chat-1", LOTTIE)).toBe(true);
    expect(await restarted.has("chat-1", `${LOTTIE}#fragment`)).toBe(true);
    expect(await restarted.has("chat-1", "https://cdn.example-cdn.com/other.json")).toBe(false);
    expect(await restarted.has("chat-2", LOTTIE)).toBe(false);
  });

  it("writes the file inside the chat's own directory as derived data", async () => {
    const log = new WebsiteResourceLog({ fileOf });
    await log.rememberRead("chat-1", read);
    const stored: unknown = JSON.parse(await readFile(await fileOf("chat-1"), "utf8"));
    expect(stored).toMatchObject({ schema: "openvids.website-resources/1" });
  });

  it("starts from an empty log when the file is damaged, and writes a good one on the next read", async () => {
    const file = await fileOf("chat-1");
    await mkdir(join(root, "chat-1"), { recursive: true });
    await writeFile(file, "{ not json", "utf8");

    const log = new WebsiteResourceLog({ fileOf });
    expect(await log.has("chat-1", LOTTIE)).toBe(false);
    await log.rememberRead("chat-1", read);
    expect(await new WebsiteResourceLog({ fileOf }).has("chat-1", LOTTIE)).toBe(true);
  });

  it("drops entries older than a week, in memory and after a restart", async () => {
    let now = 1_700_000_000_000;
    const log = new WebsiteResourceLog({ fileOf, now: () => now });
    await log.rememberRead("chat-1", read);
    now += RESOURCE_TTL_MS - 1;
    expect(await log.has("chat-1", LOTTIE)).toBe(true);
    now += 2;
    expect(await log.has("chat-1", LOTTIE)).toBe(false);
    expect(await new WebsiteResourceLog({ fileOf, now: () => now }).has("chat-1", LOTTIE)).toBe(
      false,
    );
  });

  it("keeps an in-memory log without a file when none is configured", async () => {
    const log = new WebsiteResourceLog();
    await log.rememberRead("chat-1", read);
    expect(await log.has("chat-1", LOTTIE)).toBe(true);
    expect(await new WebsiteResourceLog().has("chat-1", LOTTIE)).toBe(false);
  });
});
