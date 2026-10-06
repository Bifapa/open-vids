// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isDesignFailure } from "./errors.js";
import {
  CHROME_USER_AGENT,
  FONT_LIMITS,
  fetchGoogleFontFaces,
  googleFontsCssUrl,
  type FontFetcher,
} from "./googleFonts.js";
import { fakeWoff2 } from "./testSupport.js";

const FILE = (name: string) => `https://fonts.gstatic.com/s/inter/v13/${name}.woff2`;

function css(faces: { subset: string; weight: number; style?: string; name: string }[]): string {
  return faces
    .map(
      (face) => `/* ${face.subset} */
@font-face {
  font-family: 'Inter';
  font-style: ${face.style ?? "normal"};
  font-weight: ${face.weight};
  font-display: swap;
  src: url(${FILE(face.name)}) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}`,
    )
    .join("\n");
}

function fetcherFor(
  cssText: string,
  options: {
    onRequest?: (url: string, userAgent: string) => void;
    data?: (url: string) => Uint8Array;
  } = {},
): FontFetcher {
  return async ({ url, userAgent }) => {
    options.onRequest?.(url, userAgent);
    if (url.startsWith("https://fonts.googleapis.com/")) return Buffer.from(cssText);
    return options.data ? options.data(url) : fakeWoff2(url);
  };
}

describe("fetchGoogleFontFaces", () => {
  it("asks the CSS2 API with a browser user agent and returns every subset it lists", async () => {
    const requests: [string, string][] = [];
    const answer = css([
      { subset: "latin", weight: 400, name: "a" },
      { subset: "latin-ext", weight: 400, name: "b" },
      { subset: "cyrillic", weight: 700, name: "c" },
    ]);
    const faces = await fetchGoogleFontFaces(
      "Inter",
      [700, 400],
      false,
      fetcherFor(answer, { onRequest: (url, ua) => requests.push([url, ua]) }),
    );
    expect(requests[0]).toEqual([
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
      CHROME_USER_AGENT,
    ]);
    expect(faces.map((face) => [face.subset, face.weight, face.style])).toEqual([
      ["latin", 400, "normal"],
      ["latin-ext", 400, "normal"],
      ["cyrillic", 700, "normal"],
    ]);
    expect(faces[0]?.unicodeRange).toBe("U+0000-00FF, U+0131");
    expect(
      Buffer.from(faces[0]?.data ?? [])
        .subarray(0, 4)
        .toString(),
    ).toBe("wOF2");
  });

  it("builds the italic and multi-word family URLs the API expects", () => {
    expect(googleFontsCssUrl("Open Sans", [700, 400], true)).toBe(
      "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap",
    );
  });

  it("downloads a file that several faces share once", async () => {
    let downloads = 0;
    const answer = css([
      { subset: "latin", weight: 400, name: "same" },
      { subset: "latin", weight: 700, name: "same" },
    ]);
    const faces = await fetchGoogleFontFaces(
      "Inter",
      [400, 700],
      false,
      fetcherFor(answer, {
        onRequest: (url) => {
          if (url.includes("gstatic")) downloads += 1;
        },
      }),
    );
    expect(faces).toHaveLength(2);
    expect(downloads).toBe(1);
  });

  it("fails asset_unavailable when the API refuses the family", async () => {
    const refusing: FontFetcher = async () => {
      throw new Error("HTTP 400");
    };
    const failure = await fetchGoogleFontFaces("Nope", [400], false, refusing).catch(
      (error: unknown) => error,
    );
    expect(isDesignFailure(failure) && failure.error.code).toBe("asset_unavailable");
    expect(isDesignFailure(failure) && failure.error.message).toContain("HTTP 400");
  });

  it("fails asset_unavailable when the answer holds no font", async () => {
    const failure = await fetchGoogleFontFaces(
      "Inter",
      [400],
      false,
      fetcherFor("/* nothing */"),
    ).catch((error: unknown) => error);
    expect(isDesignFailure(failure) && failure.error.code).toBe("asset_unavailable");
  });

  it("refuses font files from any host but fonts.gstatic.com", async () => {
    const answer = css([{ subset: "latin", weight: 400, name: "a" }]).replace(
      "https://fonts.gstatic.com/",
      "https://evil.test/",
    );
    const requested: string[] = [];
    const failure = await fetchGoogleFontFaces(
      "Inter",
      [400],
      false,
      fetcherFor(answer, { onRequest: (url) => requested.push(url) }),
    ).catch((error: unknown) => error);
    expect(isDesignFailure(failure) && failure.error.code).toBe("asset_unavailable");
    expect(requested.some((url) => url.includes("evil.test"))).toBe(false);
    // An http file and a look-alike host are refused too.
    for (const bad of [
      "http://fonts.gstatic.com/s/a.woff2",
      "https://fonts.gstatic.com.evil.test/a.woff2",
    ]) {
      const swapped = css([{ subset: "latin", weight: 400, name: "a" }]).replace(FILE("a"), bad);
      const outcome = await fetchGoogleFontFaces("Inter", [400], false, fetcherFor(swapped)).catch(
        (error: unknown) => error,
      );
      expect(isDesignFailure(outcome)).toBe(true);
    }
  });

  it("refuses a family name that could change the request", async () => {
    const failure = await fetchGoogleFontFaces(
      "Inter&family=Evil",
      [400],
      false,
      fetcherFor(""),
    ).catch((error: unknown) => error);
    expect(isDesignFailure(failure) && failure.error.code).toBe("asset_unavailable");
  });

  it("enforces the file, family-file-count and family-size limits", async () => {
    const many = css(
      Array.from({ length: FONT_LIMITS.familyFiles + 1 }, (_, index) => ({
        subset: `s${index}`,
        weight: 400,
        name: `f${index}`,
      })),
    );
    const tooMany = await fetchGoogleFontFaces("Inter", [400], false, fetcherFor(many)).catch(
      (error: unknown) => error,
    );
    expect(isDesignFailure(tooMany) && tooMany.error.message).toMatch(/file limit/);

    const three = css([
      { subset: "latin", weight: 400, name: "a" },
      { subset: "latin-ext", weight: 400, name: "b" },
      { subset: "cyrillic", weight: 400, name: "c" },
    ]);
    const big = (url: string) => Buffer.concat([fakeWoff2(url), Buffer.alloc(5 * 1024 * 1024)]);
    // Each file is within the per-file cap here (the fetcher's own cap is not exercised), but the family is over 12 MB.
    const tooBig = await fetchGoogleFontFaces(
      "Inter",
      [400],
      false,
      fetcherFor(three, { data: big }),
    ).catch((error: unknown) => error);
    expect(isDesignFailure(tooBig) && tooBig.error.code).toBe("asset_unavailable");
  });

  it("passes the per-file cap and timeout to the fetcher and refuses non-woff2 bytes", async () => {
    const seen: { maxBytes: number; timeoutMs: number }[] = [];
    const answer = css([{ subset: "latin", weight: 400, name: "a" }]);
    const failure = await fetchGoogleFontFaces("Inter", [400], false, async (request) => {
      seen.push({ maxBytes: request.maxBytes, timeoutMs: request.timeoutMs });
      return request.url.includes("googleapis")
        ? Buffer.from(answer)
        : Buffer.from("<html>not a font</html>");
    }).catch((error: unknown) => error);
    expect(isDesignFailure(failure) && failure.error.message).toMatch(/not a woff2/);
    expect(seen[1]).toEqual({
      maxBytes: FONT_LIMITS.fileBytes,
      timeoutMs: FONT_LIMITS.fileTimeoutMs,
    });
  });
});
