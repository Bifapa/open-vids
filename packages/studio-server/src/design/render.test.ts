// @vitest-environment node
import { DESIGN_REQUIRED_TOKENS } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { parseDesignSystemHtml } from "./parse.js";
import { cssTimingFunction } from "./renderCss.js";
import { renderDesignSystem } from "./render.js";
import { renderInput, sampleSpec, storedFont } from "./testSupport.js";
import { validateDesignSystemHtml, validateTokensCss } from "./validate.js";

const allFiles = () => true;

describe("renderDesignSystem", () => {
  it("renders a showcase that passes its own validation, with a matching tokens.css", () => {
    const input = renderInput();
    const { systemHtml, tokensCss } = renderDesignSystem(input);
    expect(
      validateDesignSystemHtml(systemHtml, { expectedVersion: 3, fileExists: allFiles }),
    ).toEqual([]);
    expect(validateTokensCss(tokensCss)).toEqual([]);
    for (const token of DESIGN_REQUIRED_TOKENS) {
      expect(systemHtml).toContain(`${token}: `);
      expect(tokensCss).toContain(`${token}: `);
    }
    // One @font-face per stored file, relative URLs, in both files.
    expect(tokensCss).toContain(
      'src: url("fonts/inter-400-normal-latin-abcd1234.woff2") format("woff2");',
    );
    expect(systemHtml).toContain('src: url("fonts/inter-400-normal-latin-abcd1234.woff2")');
    expect(tokensCss).not.toMatch(/https?:/);
  });

  it("reads back to the same spec and manifest it was rendered from", () => {
    const spec = sampleSpec({ fonts: [] });
    const input = renderInput({ spec });
    const { systemHtml } = renderDesignSystem(input);
    const parsed = parseDesignSystemHtml(systemHtml);
    expect(parsed.spec).toEqual({
      ...spec,
      fonts: input.fonts.map(({ files: _files, portable: _portable, ...font }) => font),
      logo: { projectPath: "logo.svg", license: input.logo?.license },
    });
    expect(parsed.manifest).toMatchObject({
      schema: "openvids.design-system/1",
      version: 3,
      source: { kind: "video", ref: "clip.mp4" },
      logo: { path: "logo.svg" },
    });
    expect(parsed.manifest.fonts[0]?.files[0]?.path).toBe(
      "fonts/inter-400-normal-latin-abcd1234.woff2",
    );
  });

  it("shows guesses in the page and lists them in the manifest", () => {
    const input = renderInput({
      fonts: [{ ...storedFont("Inter"), guess: true }],
    });
    const { systemHtml } = renderDesignSystem(input);
    expect(systemHtml).toContain("similar (guess)");
    expect(systemHtml).toContain("Guessed, not confirmed");
    const { manifest } = parseDesignSystemHtml(systemHtml);
    expect(manifest.guesses).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Font "Inter"'),
        expect.stringContaining('Transition "Slide in"'),
      ]),
    );
  });

  it("marks system fonts as not portable and unknown licenses", () => {
    const { systemHtml } = renderDesignSystem(
      renderInput({
        fonts: [
          {
            family: "Helvetica Neue",
            role: "body",
            source: "system",
            weights: [400],
            license: null,
            files: [],
            portable: false,
          },
        ],
      }),
    );
    expect(systemHtml).toContain("system font: not portable");
    expect(systemHtml).toContain("license unknown");
    expect(systemHtml).not.toContain("@font-face");
  });

  it("animates each transition over its own duration with its own ease", () => {
    const { systemHtml } = renderDesignSystem(renderInput());
    // fade 0.4 s + 1.4 s hold = 1.8 s cycle; power2.out becomes its cubic-bezier
    expect(systemHtml).toContain(".ov-anim-0 { animation: ov-k0 1.8s linear infinite; }");
    expect(systemHtml).toContain("animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1)");
    expect(systemHtml).toContain(".ov-anim-1 { animation: ov-k1 2s linear infinite; }");
    expect(systemHtml).toContain("animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(systemHtml).toContain("animation-timing-function: steps(1, end)");
  });

  it("escapes every text it interpolates", () => {
    const hostile = `<img src=x onerror=alert(1)> & "q"`;
    const spec = sampleSpec({
      fonts: [],
      summary: hostile,
      motionRules: [hostile],
      dos: [hostile],
      donts: [hostile],
      colorNames: { "--brand": 'Brand & "co"' },
      transitions: [{ name: hostile, kind: "fade", durationSec: 1, ease: "ease", note: hostile }],
    });
    const input = renderInput({
      spec,
      source: { kind: "website", ref: "</script><script>alert(1)</script>" },
      fonts: [{ ...storedFont("Inter"), license: { name: hostile, url: "javascript:alert(1)" } }],
    });
    const { systemHtml } = renderDesignSystem(input);
    expect(validateDesignSystemHtml(systemHtml, { fileExists: allFiles })).toEqual([]);
    expect(systemHtml).not.toContain("<img src=x");
    expect(systemHtml.match(/<script/g)).toHaveLength(1);
    // The JSON block carries the hostile text and still reads back to it.
    const parsed = parseDesignSystemHtml(systemHtml);
    expect(parsed.spec.dos).toEqual([hostile]);
    expect(parsed.manifest.source.ref).toBe("</script><script>alert(1)</script>");
  });

  it("refuses a token value that is not safe CSS", () => {
    const spec = sampleSpec({ fonts: [] });
    spec.tokens["--bg"] = "red; } body { background: url(https://evil.test/x)";
    expect(() => renderDesignSystem(renderInput({ spec }))).toThrow(/--bg/);
  });

  it("draws the thumbnail as plain SVG from the palette and the display font", () => {
    const { thumbnailSvg } = renderDesignSystem(renderInput());
    expect(thumbnailSvg).toContain("<svg");
    expect(thumbnailSvg).toContain("Inter");
    expect(thumbnailSvg).toContain("#ff6a3d");
    expect(thumbnailSvg).not.toMatch(/<script|href=|<image|https?:\/\/(?!www\.w3\.org)/i);
  });

  it("escapes the font name in the thumbnail and never paints a token that is not a colour", () => {
    const spec = sampleSpec({ fonts: [] });
    spec.tokens["--brand"] = "var(--x)";
    const { thumbnailSvg } = renderDesignSystem(
      renderInput({
        spec,
        fonts: [{ ...storedFont('A"><script>x</script>'), family: 'A"><script>x</script>' }],
      }),
    );
    expect(thumbnailSvg).not.toContain("<script>");
    expect(thumbnailSvg).not.toContain("var(");
  });
});

describe("cssTimingFunction", () => {
  it("keeps CSS timing functions, maps GSAP names and falls back to ease", () => {
    expect(cssTimingFunction("ease-in-out")).toBe("ease-in-out");
    expect(cssTimingFunction("cubic-bezier(0.1, 0.2, 0.3, 1)")).toBe(
      "cubic-bezier(0.1, 0.2, 0.3, 1)",
    );
    expect(cssTimingFunction("power3.inOut")).toBe("cubic-bezier(0.76, 0, 0.24, 1)");
    expect(cssTimingFunction("none")).toBe("linear");
    expect(cssTimingFunction("elastic.out(1, 0.3)")).toBe("ease");
    expect(cssTimingFunction("cubic-bezier(1, 2, 3, red)")).toBe("ease");
  });
});
