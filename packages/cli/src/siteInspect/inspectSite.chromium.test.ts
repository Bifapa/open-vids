import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectSite } from "./inspectSite.js";
import { SiteInspectError } from "./siteSession.js";
import type { RequestPolicy } from "./requestPolicy.js";

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

const PAGE = (secretPort: number) => `<!doctype html>
<html lang="en"><head><title>Brand Co</title>
<meta name="description" content="A fixture brand">
<meta name="theme-color" content="#101020">
<link rel="stylesheet" href="/site.css">
<style>:root { --color-brand: #ff5500; --font-display: "Brand Sans"; }</style>
</head><body>
<header><a href="/" class="logo" aria-label="Brand Co"><svg viewBox="0 0 40 20" width="80" height="40" fill="currentColor"><rect width="40" height="20" rx="4"/></svg></a>
<nav><a href="/a">Product</a><a href="/b">Pricing</a></nav></header>
<main><h1>Motion for everyone</h1>
<p>Brand Co builds calm tools for teams who care about the details of their work.</p>
<button class="cta">Start now</button>
<img src="/hero.png" width="120" height="60" alt="Hero">
<div class="panel"></div>
<img src="http://127.0.0.1:${secretPort}/secret.png" width="10" height="10" alt="">
</main></body></html>`;

const CSS = `
@font-face { font-family: "Brand Sans"; font-weight: 700; src: url(/brand-sans.woff2) format("woff2"); }
@keyframes rise { from { transform: translateY(8px); } to { transform: none; } }
body { margin: 0; background: #101020; color: #f2f2f8; font: 16px/1.5 "Brand Sans", sans-serif; }
header { display: flex; gap: 24px; padding: 16px 32px; color: #f2f2f8; }
.logo { color: #f2f2f8; }
nav a { color: #9aa0c0; margin-right: 16px; text-decoration: none; }
h1 { font: 700 60px/1.1 "Brand Sans", sans-serif; margin: 120px 32px 16px; }
p { margin: 0 32px 24px; max-width: 640px; color: #9aa0c0; }
.cta { margin-left: 32px; background: #ff5500; color: #101020; border: 0; border-radius: 999px; padding: 12px 28px;
  font: 600 16px "Brand Sans", sans-serif; transition: transform 240ms cubic-bezier(0.2, 0, 0, 1); animation: rise 600ms ease-out; }
.panel { height: 160px; background-image: url("/bg.png"); background-size: cover; }
`;

describe.runIf(executablePath)("inspectSite in Chromium", () => {
  let site: Server;
  let secret: Server;
  let siteUrl = "";
  let secretPort = 0;
  let secretHits = 0;
  let out = "";

  beforeAll(async () => {
    secret = createServer((_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "image/png" }).end("png");
    });
    secretPort = await listen(secret);
    site = createServer((req, res) => {
      if (req.url === "/")
        res.writeHead(200, { "content-type": "text/html" }).end(PAGE(secretPort));
      else if (req.url === "/site.css") res.writeHead(200, { "content-type": "text/css" }).end(CSS);
      else if (req.url === "/hero.png" || req.url === "/bg.png")
        res.writeHead(200, { "content-type": "image/png" }).end("png");
      else if (req.url === "/brand-sans.woff2")
        res.writeHead(200, { "content-type": "font/woff2" }).end("wOF2-not-a-real-font");
      else res.writeHead(404).end("missing");
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    out = mkdtempSync(join(tmpdir(), "openvids-site-test-"));
  });
  afterAll(() => {
    site?.close();
    secret?.close();
    rmSync(out, { recursive: true, force: true });
  });

  // The fixture lives on loopback, which the real policy refuses: this one allows the fixture host and refuses the
  // "secret" service, the way the real policy refuses an internal address a public page points at.
  const policy = (): RequestPolicy => ({
    check: async (url) =>
      new URL(url).port === String(secretPort)
        ? { kind: "blocked", reason: "127.0.0.1 is a local or private network address" }
        : null,
    vet: async (host) => ({ ok: true, addresses: [host] }),
  });
  const launch = () => puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

  it("extracts the palette, fonts, type scale, button, logo, motion and screenshots of a page", async () => {
    const result = await inspectSite({
      url: `${siteUrl}/`,
      outDir: out,
      signal: new AbortController().signal,
      policy: policy(),
      launch,
    });
    const { site: style } = result;

    expect(style).toMatchObject({
      title: "Brand Co",
      description: "A fixture brand",
      themeColor: "#101020",
      language: "en",
    });
    expect(style.colors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hex: "#101020", role: "background" }),
        expect.objectContaining({ hex: "#f2f2f8", role: "text" }),
        expect.objectContaining({ hex: "#9aa0c0", role: "muted" }),
        expect.objectContaining({ hex: "#ff5500", role: "accent" }),
      ]),
    );
    expect(style.fonts[0]).toMatchObject({
      family: "Brand Sans",
      source: "self_hosted",
      usedFor: expect.arrayContaining(["heading"]),
    });
    expect(result.fonts).toEqual([
      expect.objectContaining({ family: "Brand Sans", weight: 700, mimeType: "font/woff2" }),
    ]);
    expect(readFileSync(join(out, result.fonts[0]?.file ?? "none"), "utf8")).toBe(
      "wOF2-not-a-real-font",
    );
    expect(style.textStyles.find((s) => s.element === "h1")).toMatchObject({
      fontSizePx: 60,
      fontWeight: 700,
    });
    expect(style.buttons[0]).toMatchObject({
      label: "Start now",
      background: "#ff5500",
      radiusPx: 999,
      fontWeight: 600,
    });
    expect(style.tokens).toEqual(
      expect.arrayContaining([{ name: "--color-brand", value: "#ff5500" }]),
    );
    expect(style.motion.durationsMs).toEqual(expect.arrayContaining([240, 600]));
    expect(style.motion.easings).toEqual(expect.arrayContaining(["cubic-bezier(0.2, 0, 0, 1)"]));
    expect(style.motion.keyframes).toContain("rise");
    expect(style.headings[0]).toBe("Motion for everyone");
    expect(style.navLabels).toEqual(["Product", "Pricing"]);

    // Files the page uses: DOM references (an image, a CSS background) plus every response, ordered media first.
    expect(style.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${siteUrl}/hero.png`,
          kind: "image",
          mimeType: "image/png",
          usage: "img",
        }),
        expect.objectContaining({
          url: `${siteUrl}/bg.png`,
          kind: "image",
          usage: "CSS background of .panel",
        }),
        expect.objectContaining({ url: `${siteUrl}/brand-sans.woff2`, kind: "font" }),
        expect.objectContaining({ url: `${siteUrl}/site.css`, kind: "stylesheet" }),
      ]),
    );
    const kinds = style.resources.map((entry) => entry.kind);
    expect(kinds.indexOf("image")).toBeLessThan(kinds.indexOf("font"));
    expect(kinds.indexOf("font")).toBeLessThan(kinds.indexOf("stylesheet"));

    expect(result.logo).toMatchObject({ file: "logo.svg", mimeType: "image/svg+xml" });
    const svg = readFileSync(join(out, "logo.svg"), "utf8");
    expect(svg).toContain("<rect");
    expect(svg).toContain('color="#f2f2f8"');
    expect(style.logos[0]).toMatchObject({ source: "inline_svg", captured: true });

    const shots = result.screenshots.map((shot) => readFileSync(join(out, shot.file)));
    for (const bytes of shots) expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(result.screenshots[0]).toMatchObject({ name: "viewport.jpg", width: 1440, height: 900 });
  });

  it("never lets the page reach a private address: the subresource is aborted and reported, nothing is requested", async () => {
    secretHits = 0;
    const result = await inspectSite({
      url: `${siteUrl}/`,
      outDir: out,
      signal: new AbortController().signal,
      policy: policy(),
      launch,
    });
    expect(secretHits).toBe(0);
    expect(result.site.notes.join(" ")).toMatch(
      /1 request was refused because the address is local or private/,
    );
  });

  it("fails a page that answers an error, and a page the policy refuses, with typed errors", async () => {
    const run = (url: string) =>
      inspectSite({
        url,
        outDir: out,
        signal: new AbortController().signal,
        policy: policy(),
        launch,
      });
    await expect(run(`${siteUrl}/missing`)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("404"),
    });
    await expect(run(`http://127.0.0.1:${secretPort}/`)).rejects.toMatchObject({
      code: "blocked_by_policy",
    });
    await expect(run(`http://127.0.0.1:${secretPort}/`)).rejects.toBeInstanceOf(SiteInspectError);
  });

  it("closes the browser and cleans its profile when aborted", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("openvids-site-"));
    const abort = new AbortController();
    const pending = inspectSite({
      url: `${siteUrl}/`,
      outDir: out,
      signal: abort.signal,
      policy: policy(),
      launch,
      onProgress: (message) => {
        if (message.startsWith("Opening")) abort.abort(new Error("stop"));
      },
    });
    await expect(pending).rejects.toThrow("stop");
    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("openvids-site-") && !name.startsWith("openvids-site-test-"),
    );
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
    expect(existsSync(out)).toBe(true);
  });
});
