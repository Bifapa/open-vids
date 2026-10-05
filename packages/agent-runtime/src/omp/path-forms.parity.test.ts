import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isUrlShaped, resolveLikeOmp } from "./path-forms.ts";

interface Probe {
  results: Array<{
    spelling: string;
    read: string | null;
    write: string | null;
    writeQuoted: string | null;
    url: boolean;
  }>;
  fetchEnabled: boolean;
}

const cwd = path.resolve(path.sep, "work", "project");
const outside = path.resolve(path.sep, "work", "outside", "secret.txt");
const relativeOutside = path.relative(cwd, outside);

const SPELLINGS = [
  "src/a.html",
  "./src/a.html",
  outside,
  `@${outside}`,
  `:${outside}`,
  `[${outside}]`,
  `[${outside}#ABCD]`,
  `:[${outside}]`,
  `"${outside}"`,
  relativeOutside,
  `:${relativeOutside}`,
  `[${relativeOutside}]`,
  `[${relativeOutside}#ABCD]`,
  `"${relativeOutside}"`,
  `@${relativeOutside}`,
  `:./src/a.html`,
  "[index.html]",
  "[index.html#ABCD]",
  "@src/a.html",
  "~",
  "~/x",
  "~user/x",
  "~/../x",
  "http://127.0.0.1:1/x",
  "http:/127.0.0.1:1/x",
  "HTTPS:/example.com/x",
  "www.example.com",
  "www.example.com/a.mp4:1-5",
  "file:///etc/hosts",
  "agent://0",
  "local:/x",
  "LOCAL:/x/y.md",
  "@local:/x",
  "[local:/x]",
  "[local:/x#ABCD]",
  '"local:/x"',
  "local://x",
  "agent:/0",
  "artifact:/1",
  "skill:/x",
  "memory:/root",
  "issue:/1",
  "pr:/1",
  "mcp:/x",
  "wwwroot/a.html",
];

function runProbe(): Probe {
  const script = fileURLToPath(new URL("./path-forms.probe.ts", import.meta.url));
  const output = execFileSync("bun", [script, cwd, JSON.stringify(SPELLINGS)], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

describe("path readings against OMP's real resolver (run under Bun)", () => {
  const probe = runProbe();

  it("covers every file OMP's resolver lands on, for every tool's normalization", () => {
    for (const { spelling, read, write, writeQuoted, url } of probe.results) {
      if (url) continue; // fetched, never resolved as a file
      const readings = resolveLikeOmp(cwd, spelling);
      const routedAway = [read, write, writeQuoted].includes(null);
      for (const [tool, landed] of Object.entries({ read, write, writeQuoted })) {
        if (landed === null) continue;
        if (readings === null) {
          // refused outright: OMP reads `file://` as a local path, the guards do not take the detour; or
          // another tool routes the same spelling to a scheme handler (`[local:/x]`: read keeps the
          // brackets, write unwraps them), so the guards refuse it for every tool
          if (routedAway) continue;
          expect(spelling, `${tool} ${spelling} → ${landed}`).toMatch(/^file:\/\//);
          continue;
        }
        expect(readings, `${tool} ${spelling}`).toContain(path.resolve(landed));
      }
    }
  });

  it("calls every spelling URL that OMP's read fetches, and every scheme OMP routes away", () => {
    for (const { spelling, url, read, write, writeQuoted } of probe.results) {
      if (url || [read, write, writeQuoted].includes(null)) {
        expect(resolveLikeOmp(cwd, spelling), spelling).toBeNull();
      }
    }
    expect(isUrlShaped("http:/127.0.0.1:1/x")).toBe(true);
    expect(isUrlShaped("www.example.com")).toBe(true);
    expect(isUrlShaped("local:/x")).toBe(true);
    expect(isUrlShaped("LOCAL:/x")).toBe(true);
    expect(isUrlShaped("local://x")).toBe(true);
  });

  it("really reaches outside the project with the spellings the guard must catch", () => {
    // If OMP stops resolving these outside, the corpus no longer proves anything.
    const landed = (spelling: string) => probe.results.find((r) => r.spelling === spelling);
    expect(landed(`:${outside}`)?.read).toBe(outside);
    expect(landed(`@${outside}`)?.read).toBe(outside);
    expect(landed(`[${outside}]`)?.write).toBe(outside);
    expect(landed(`:${relativeOutside}`)?.read).toBe(path.resolve(cwd, relativeOutside));
    // OMP may join the home dir with a forward slash on Windows; compare resolved paths.
    expect(path.resolve(landed("~/x")?.read ?? "")).toBe(path.join(homedir(), "x"));
    expect(path.resolve(landed("~user/x")?.read ?? "")).toBe(path.join(homedir(), "user", "x"));
  });

  it("runs agent sessions with URL reads disabled", () => {
    expect(probe.fetchEnabled).toBe(false);
  });
});
